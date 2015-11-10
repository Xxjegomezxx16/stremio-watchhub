var Stremio = require("stremio-addons");
var needle = require("needle");
var _ = require("lodash");
var bagpipe = require("bagpipe");

var stremioCentral = "http://api8.herokuapp.com";
//var mySecret = "your secret"; 

var GUIDEBOX_KEY = "rKW2ZdAfUFVcmiFfJxNfejuqntjb91TH";
var GUIDEBOX_REGION = "US"; // TODO: UK
var GUIDEBOX_BASE = "http://api-public.guidebox.com/v1.43/"+GUIDEBOX_REGION+"/"+GUIDEBOX_KEY;

var pkg = require("./package");
var manifest = { 
    "id": "org.stremio.guidebox",
    "types": ["movie", "series"],
    "filter": { "query.imdb_id": { "$exists": true }, "query.type": { "$in":["series","movie"] } },
    name: pkg.displayName, version: pkg.version, description: pkg.description,
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

var pipe = new bagpipe(5);

var opts = { follow_max: 3, open_timeout: 10*1000, json: true };

// TODO: cache all calls to guidebox over leveldb/mongodb/redis (leveldb seems best) with TTL
// Then, this will become obsolete 
// guidebox is limited to 100 000 / month

var idCache = {}; 
function getGuideBoxId(query, callback)
{
    var imdb_id = query.imdb_id;
    if (! imdb_id) return callback(new Error("imdb_id should be provided"));
    if (idCache[imdb_id]) return callback(null, idCache[imdb_id]);
    needle.get(GUIDEBOX_BASE+"/search/"+( query.hasOwnProperty("season") ? "" : "movie/" )+"id/imdb/"+imdb_id, opts, function(err, resp, body) {
        if (err) return callback(err);
        idCache[imdb_id] = body.id;
        return callback(null, body.id);
    });
}

var guideboxCache = { }, guideboxPrg = {};
function guideboxGet(path, callback) {
    if (guideboxCache[path]) return callback(null, guideboxCache[path]);

    if (guideboxPrg[path]) return guideboxPrg[path].push(callback); // wait for stuff in progress
    guideboxPrg[path] = [];

    needle.get(GUIDEBOX_BASE+path, function(err, resp, body) {
        if (body) { guideboxCache[path] = body; setTimeout(function() { delete guideboxCache[path] }, 60*60*1000) };
        callback(err, body);

        if (guideboxPrg[path]) { guideboxPrg[path].forEach(function(c){ c(err, body) }) };
        delete guideboxPrg[path];
    });
}

function getStream(args, callback, user) {
    if (! args.query) return callback();

    getGuideBoxId(args.query, function(err, id) {
        if (err) { console.error(err) ; return callback({ code: 0, message: "internal error" }) }

        if (! id) { console.error("did not manage to match imdb id to guidebox"); return callback(null, []); }
        
        var sources = "all", // "free", "tv_everywhere", "subscription", "purchase" or "all"; TODO free
            platform = "web"; // "web", "ios", "android" or "all"

        // TODO: isolate this in getGuidebox(), cache it with TTL
        if (args.query.hasOwnProperty("season")) {
            // TV show
            guideboxGet("/show/"+id+"/episodes/"+args.query.season+"/0/100/"+sources+"/"+platform+"/true", function(err, body) {
                if (err) { console.error(err) ; return callback({ code: 1, message: "internal error" }) }
                serve(_.findWhere(body.results, { episode_number: parseInt(args.query.episode), season_number: parseInt(args.query.season) }));
            });
        } else {
            // Movie
            guideboxGet("/movie/"+id, function(err, body) {
                if (err) { console.error(err) ; return callback({ code: 2, message: "internal error" }) }
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
                }
            }));
        };
    });
}

//pipe.push(getStream, {query:{imdb_id:"tt0816692"}},function(){console.log(Date.now(), arguments)})
//pipe.push(getStream, {query:{imdb_id:"tt0816692"}},function(){console.log(Date.now(), arguments)})


var addon = new Stremio.Server({
    "stream.get": function(args, callback, user) {
        pipe.push(getStream, args, function(err, resp) { callback(err, resp ? (resp[0] || null) : undefined) })
    },
    "stream.find": function(args, callback, user) {
        pipe.push(getStream, args, function(err, resp) { callback(err, resp ? resp.slice(0,4) : undefined) }); 
    }
}, { /* secret: mySecret */ allow: ["http://api8.herokuapp.com","http://api9.strem.io"] }, manifest);

var server = require("http").createServer(function (req, res) {
    addon.middleware(req, res, function() { res.end() }); // wire the middleware - also compatible with connect / express
}).on("listening", function()
{
    console.log("Guidebox Stremio Addon listening on "+server.address().port);
}).listen(process.env.PORT || 9005);
