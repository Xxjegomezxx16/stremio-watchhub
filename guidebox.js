var Stremio = require("stremio-addons");
var needle = require("needle");
var _ = require("lodash");
var bagpipe = require("bagpipe");

var stremioCentral = "http://api9.strem.io";

var GUIDEBOX_KEY = process.env.GUIDEBOX_KEY;
//var GUIDEBOX_KEY = "process.env.GUIDEBOX_KEY";
var GUIDEBOX_REGION = "US"; // TODO: UK
var GUIDEBOX_BASE = "http://api-public.guidebox.com/v1.43/"+GUIDEBOX_REGION+"/"+GUIDEBOX_KEY;

var pkg = require("./package");
var manifest = { 
    "id": "org.stremio.guidebox",
    "types": ["movie", "series"],
    "filter": { 
        "query.imdb_id": { "$exists": true }, 
        "query.type": { "$in":["series","movie", "channel"] }, 

        // leanback mode
        "query.guidebox_id": { "$exists": true },
        "popularities.guidebox": { "$exists": true },
    },
    name: pkg.displayName, version: pkg.version, description: pkg.description,
    icon: "http://www.strem.io/images/icon-guidebox-addon.png",
    logo: "http://www.strem.io/images/addons/guidebox-logo.png",
    geolocation: ["US", "GB", "CA", "GE", "IL", "FR", "BG", "DK"],
    repository:  "http://github.com/Ivshti/guidebox-stremio",
    endpoint: "http://guidebox.strem.io/stremioget/stremio/v1",
    settings: [{
        name: "Default source",
        type: "select",
        options: [ "All services", "Free services", "Subscription services", "TV Everywhere services", "Netflix", "Hulu", "iTunes", "VUDU"]
    }],
    sorts: [ 
        { prop: "popularities.guidebox", name: "Guidebox", types: ["channel"] }, // leanback mode channels
    ] 
};

if (true || !process.env.DISABLE_FREE) { 
   // series is disabled because:
   // 1) landscape image
   // 2) not all episodes are free
   // 3) overlaps with popular series, as most of them are popular
   // WARNING: noDiscoverTab is enabled for now; disable it at some point
   manifest.sorts.push({ prop: "popularities.guidebox_free", name: "Free", types: ["movie", /* "series" */], noDiscoverTab: true });
}

var methods = { };

/* 
 * Guildebox API guide
 * https://api.guidebox.com/apidocs#movies
 */

var DAY = 24*60*60*1000;

var pipe = new bagpipe(100); 

var opts = { follow_max: 3, open_timeout: 10*1000, json: true };

var cacheSet, cacheGet, red;
if (process.env.REDIS) {
    // In redis
    console.log("Using redis caching");

    var redis = require("redis");
    red = redis.createClient(process.env.REDIS);
    red.on("error", function(err) { console.error("redis err",err) });

    cacheGet = function (domain, key, cb) { 
        red.get(domain+":"+key, function(err, res) { 
            if (err) return cb(err);
            if (process.env.CACHING_LOG) console.log("cache on "+domain+":"+key+": "+(res ? "HIT" : "MISS"));
            if (!res) return cb(null, null);
            try { cb(null, JSON.parse(res)) } catch(e) { cb(e) }
        }); 
    };
    cacheSet = function (domain, key, value, ttl) {
        if (ttl) red.setex(domain+":"+key, ttl/1000, JSON.stringify(value), function(e){ if (e) console.error(e) });
        else red.set(domain+":"+key, JSON.stringify(value), function(e) { if (e) console.error(e) });
    }
} else {
    // In memory
    var cache = {};
    cacheGet = function (domain, key, cb) { cb(null, cache[domain+":"+key]) }
    cacheSet = function(domain, key, value, ttl) 
    {
        cache[domain+":"+key] = value;
        if (ttl && ttl < 2*DAY) setTimeout(function() { delete cache[domain+":"+key] }, ttl);
    }
}


function getGuideBoxId(query, callback)
{
    var imdb_id = query && query.imdb_id;
    if (! imdb_id) return callback(new Error("imdb_id should be provided"));

    cacheGet("guidebox-id", imdb_id, function(err, res) {
        if (err) console.error(err);
        if (res) return callback(null, res);

        needle.get(GUIDEBOX_BASE+"/search/"+( query.hasOwnProperty("season") ? "" : "movie/" )+"id/imdb/"+imdb_id, opts, function(err, resp, body) {
            if (body && body.error) return callback(new Error(body.error));
            if (err) return callback(err);
            if (body.id) cacheSet("guidebox-id", imdb_id, body.id, 365*DAY);
            return callback(null, body.id);
        });
    });
}

var guideboxCache = { }, guideboxPrg = {};
function guideboxGet(path, callback) {
    cacheGet("guidebox", path, function(err, res) {
        if (res) return callback(null, res);

        if (guideboxPrg[path]) return guideboxPrg[path].push(callback); // wait for stuff in progress
        
        guideboxPrg[path] = [];

        needle.get(GUIDEBOX_BASE+path, function(err, resp, body) {
            if (err) { console.error("guidebox error at "+path, err) }

            if (err) { err = err; body = null; }
            if (body && body.error) { err = body.error; body = null; }

            var useful = body && ((body.results && body.results.length) || body.id);
            var expire = useful ? (path.match("movie") ? 15*DAY : 6*DAY) : 2*DAY;
            if (body) cacheSet("guidebox", path, body, expire);
            
            callback(err, body);
            if (guideboxPrg[path]) { guideboxPrg[path].forEach(function(c) { c(err, body) }) };
            delete guideboxPrg[path];
        });
    });
}

function getStream(args, callback) {
    if (! (args.query && args.query.imdb_id)) return callback(null, []);

    getGuideBoxId(args.query, function(err, id) {
        if (err) { console.error(err) ; return callback({ code: 9001, message: "cannot get guidebox id" }) }

        if (! id) { console.error("did not manage to match imdb id to guidebox ("+args.query.imdb_id+")"); return callback(null, []); }
        
        var sources = "all", // "free", "tv_everywhere", "subscription", "purchase" or "all"; TODO free
            platform = "web"; // "web", "ios", "android" or "all"

        // TODO: isolate this in getGuidebox(), cache it with TTL
        var isSeries = args.query.hasOwnProperty("season") || args.query.type == "series";
        if (isSeries) {
            // TV show
            guideboxGet("/show/"+id+"/episodes/"+args.query.season+"/0/100/"+sources+"/"+platform+"/true", function(err, body) {
                if (err) { console.error(err) ; return callback({ code: 9002, message: "can not get guidebox season" }) }
                serve(_.findWhere(body.results, { episode_number: parseInt(args.query.episode), season_number: parseInt(args.query.season) }));
            });
        } else {
            // Movie
            guideboxGet("/movie/"+id, function(err, body) {
                if (err) { console.error(err) ; return callback({ code: 9003, message: "can not get guidebox movie" }) }
                serve(body);
            });
        }

        function serve(body) {
            if (! body) return callback(null, [ ]);
            // TODO: preferences - HD vs SD
            var sources = (body.free_web_sources || [])
            .concat(body.subscription_web_sources || [])
            .concat(body.tv_everywhere_web_sources || [])
            .concat(body.purchase_web_sources || []);

            //console.log(body);

            if (red && (body.free_web_sources || []).length) 
                red.zincrby("guidebox_free_"+(isSeries ? "series" : "movies"), 1.0, args.query.imdb_id, function(err) { if (err) console.error(err) });
            // zrange guidebox_free_movies 0 70 withscores

            // TODO: return many results if the Add-on API allows it 
            callback(null, sources.map(function(source) {
                var isFree = (body.free_web_sources || []).indexOf(source) > -1;
                var isSubscription = (body.subscription_web_sources || []).indexOf(source) > -1;

                var title = (source.formats || [])
                    .sort(function(a, b) { return parseFloat(a.price) - parseFloat(b.price) }).slice(0,2)
                    .map(function(t) { return t.price+"$ to "+t.type+" "+t.format }).join(", ");

                var tag = [source.source];
                if (_.findWhere(source.formats, { format: "HD" })) tag.push("hd");

                return {
                    availability: 3,
                    name: source.display_name,
                    title: title, tag: tag,
                    externalUrl: source.link,
                    isFree: isFree,
                    isSubscription: isSubscription
                }
            }));
        };
    });
}

methods["stream.find"] = function(args, callback) {
    // TODO: do something if the queue is saturated
    pipe.push(getStream, args, function(err, resp) { callback(err, resp ? resp.slice(0,4) : undefined) }); 
};

//pipe.push(getStream, {query:{imdb_id:"tt0816692"}},function(){console.log(Date.now(), arguments)})
//pipe.push(getStream, {query:{imdb_id:"tt0816692"}},function(){console.log(Date.now(), arguments)})


/* Leanback mode - implement as channels
 */
var leanbackChannels = [];
function findLeanback(args, callback) {
    guideboxGet("/leanback/all/0/200", function(err, all) {
        if (err) console.error(err);
        
        leanbackChannels = (all && all.results && all.results.map(function(channel, i, channels) {
            return {
                id: "guidebox_id:"+channel.id,
                // we have channel imdb_id sometimes, also freebase, wikipedia, tvdb
                posterShape: "landscape",
                poster: channel.artwork_448x252 || channel.artwork_608x342,
                banner: channel.artwork_608x342,
                name: channel.title,
                type: "channel",
                popularities: { guidebox: channels.length-i },
            }
        })) || leanbackChannels;

        callback(err ? { code: 9050, message: err.message || err } : null, leanbackChannels);
    });
}
findLeanback({}, function() { }); // get leanbackChannels

function getLeanback(args, callback) {
    if (! args.query) return callback(new Error("no query"));
    if (! args.query.guidebox_id) return callback(new Error("no guidebox_id"));
    guideboxGet("/leanback/"+args.query.guidebox_id+"/0/100", function(err, videos) {
        if (err) return callback({ message: err.message || err, code: 9051 });

        var channel = _.findWhere(leanbackChannels, { id: "guidebox_id:" + args.query.guidebox_id });
        if (! channel) return callback({ message: "no channel found" });

        callback(null, _.extend(_.merge({}, channel), { uploads: (videos.results || []).map(function(v) {
            var stream = _.findWhere(v.free_web_sources, { source: "youtube" });
            return {
                title: v.title,
                publishedAt: new Date(v.first_aired),
                id: stream && (stream.embed ? stream.embed.split("/").pop() : (stream.link ? stream.link.split("=").pop() : null)),
                thumbnail: v.thumbnail_304x171
            }
        }) }));
    });
}


function findFree(args, callback) {
    // /movies/all/ {limit 1} / {limit 2} / {sources} / {platform}

    guideboxGet( "/" + (args.query.type == "series" ? "shows" : "movies") + "/all/0/100/free/all", function(err, body) {
        if (err) return callback(err);
        var items = body && body.results;
        if (! Array.isArray(items)) callback(new Error(".results is not an array"));

        callback(null, items.map(function(x, i) {
            return {
                imdb_id: x.imdb_id || x.imdb, 
                name: x.title,
                year: x.release_year,
                type: args.query.type,
                // in_theaters
                // freebase, wikipedia_id, tvrage,  themoviedb, tvdb, 
                poster: x.artwork_448x252 || x.poster_240x342, // poster_400x570
                posterShape: x.artwork_448x252 ? "landscape" : undefined,
                popularities: { guidebox_free: items.length - i + 1 }
            }
        }))
    });
}

methods["meta.find"] = function(args, callback) { 
    if (! args.query) return callback(new Error("no query"));

    if (args.query.type === "channel") findLeanback(args, callback);
    else findFree(args, callback);
};
methods["meta.get"] = function(args, callback) { getLeanback(args, callback); };



/* Init add-on
 */
var addon = new Stremio.Server(methods, { stremioget: true, allow: ["http://api9.strem.io"] }, manifest);

var server = require("http").createServer(function (req, res) {
    addon.middleware(req, res, function() { res.end() }); // wire the middleware - also compatible with connect / express
}).on("listening", function()
{
    console.log("Guidebox Stremio Addon listening on "+server.address().port);
}).listen(process.env.PORT || 9005);

