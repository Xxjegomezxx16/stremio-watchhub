var Stremio = require("stremio-addons");
var needle = require("needle");
var _ = require("lodash");
var bagpipe = require("bagpipe");

var stremioCentral = "http://api8.herokuapp.com";

var GUIDEBOX_KEY = "rKxOgfnnBG0zBhycLnBIILMPOCbp7XPR";
//var GUIDEBOX_KEY = "rKW2ZdAfUFVcmiFfJxNfejuqntjb91TH";
var GUIDEBOX_REGION = "US"; // TODO: UK
var GUIDEBOX_BASE = "http://api-public.guidebox.com/v1.43/"+GUIDEBOX_REGION+"/"+GUIDEBOX_KEY;

var pkg = require("./package");
var manifest = { 
    "id": "org.stremio.guidebox",
    "types": ["movie", "series"],
    "filter": { "query.imdb_id": { "$exists": true }, "query.type": { "$in":["series","movie"] } },
    name: pkg.displayName, version: pkg.version, description: pkg.description,
    icon: "http://www.strem.io/images/icon-guidebox-addon.png",
    geolocation: ["US", "GB", "CA", "GE", "IL"],
    repository:  "http://github.com/Ivshti/guidebox-stremio",
    endpoint: "http://guidebox.strem.io/stremioget/stremio/v1",
    settings: [{
        name: "Default source",
        type: "select",
        options: [ "All services", "Free services", "Subscription services", "TV Everywhere services", "Netflix", "Hulu", "iTunes", "VUDU"]
    }],
};

/* 
 * Guildebox API guide
 * https://api.guidebox.com/apidocs#movies
 */

var DAY = 24*60*60*1000;

var pipe = new bagpipe(100); 

var opts = { follow_max: 3, open_timeout: 10*1000, json: true };

var cacheSet, cacheGet;
if (process.env.REDIS) {
    // In redis
    console.log("Using redis caching");

    var redis = require("redis");
    var red = redis.createClient(process.env.REDIS);
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
        if (body.error) return callback(new Error(body.error));
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
            if (err) { err = err; body = null; }
            if (body && body.error) { err = body.error; body = null; }

            var useful = body && ((body.results && body.results.length) || body.id);
            var expire = useful ? (path.match("movie") ? 15*DAY : 6*DAY) : 3*DAY;
            if (useful) cacheSet("guidebox", path, body, expire);
            
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
        if (args.query.hasOwnProperty("season") || args.query.type == "series") {
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

//pipe.push(getStream, {query:{imdb_id:"tt0816692"}},function(){console.log(Date.now(), arguments)})
//pipe.push(getStream, {query:{imdb_id:"tt0816692"}},function(){console.log(Date.now(), arguments)})


var addon = new Stremio.Server({
    "stream.get": function(args, callback, user) {
        // TODO: do something if the queue is saturated
        pipe.push(getStream, args, function(err, resp) { callback(err, resp ? (resp[0] || null) : undefined) })
    },
    "stream.find": function(args, callback, user) {
        // TODO: do something if the queue is saturated
        pipe.push(getStream, args, function(err, resp) { callback(err, resp ? resp.slice(0,4) : undefined) }); 
    }
}, { /* secret: mySecret */ stremioget: true, allow: ["http://api8.herokuapp.com","http://api9.strem.io"] }, manifest);

var server = require("http").createServer(function (req, res) {
    addon.middleware(req, res, function() { res.end() }); // wire the middleware - also compatible with connect / express
}).on("listening", function()
{
    console.log("Guidebox Stremio Addon listening on "+server.address().port);
}).listen(process.env.PORT || 9005);
