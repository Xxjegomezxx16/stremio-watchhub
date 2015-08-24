var Stremio = require("stremio-addons");
var needle = require("needle");
var _ = require("lodash");

var stremioCentral = "http://api8.herokuapp.com";
//var mySecret = "your secret"; 

var GUIDEBOX_KEY = "process.env.GUIDEBOX_KEY";
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

var addon = new Stremio.Server({
    "stream.get": function(args, callback, user) {
        if (! args.query) return callback();
        getGuideBoxId(args.query, function(err, id) {
            if (err) { console.error(err) ; return callback({ code: 0, message: "internal error" }) }

            if (! id) { console.error("did not manage to match imdb id to guidebox"); return callback(null, { availability: 0 }); }
            
            var sources = "all", // "free", "tv_everywhere", "subscription", "purchase" or "all"; TODO free
                platform = "web"; // "web", "ios", "android" or "all"

            if (args.query.hasOwnProperty("season")) {
                // TV show
                needle.get(GUIDEBOX_BASE+"/show/"+id+"/episodes/"+args.query.season+"/0/100/"+sources+"/"+platform+"/true", function(err, resp, body) {
                    if (err) { console.error(err) ; return callback({ code: 1, message: "internal error" }) }
                    serve(_.findWhere(body.results, { episode_number: parseInt(args.query.episode), season_number: parseInt(args.query.season) }));
                });
            } else {
                // Movie
                needle.get(GUIDEBOX_BASE+"/movie/"+id, function(err, resp, body) {
                    if (err) { console.error(err) ; return callback({ code: 2, message: "internal error" }) }
                    serve(body);
                });
            }

            function serve(body) {
                if (! body) return callback(null, { availability: 0 });
                // TODO: preferences - HD vs SD
                var sources = (body.free_web_sources || [])
                .concat(body.tv_everywhere_web_sources || [])
                .concat(body.purchase_web_sources || [])
                .concat(body.subscription_web_sources || []);

                //console.log(body);

                var result = { availability: Math.min(sources.length, 4) };
                if (sources[0]) _.extend(result, { name: sources[0].display_name, externalUrl: sources[0].link });
                callback(null, result);
            };
        });
        //return callback(null, dataset[args.query.imdb_id] || null);
    },
    "stream.find": function(args, callback, user) {
        // only "availability" is required for stream.find, but we can return the whole object
        // TODO
        callback(null, { items: args.items.map(function(x) { return { availability: 1 } }) });
    }
}, { /* secret: mySecret */ }, manifest);

var server = require("http").createServer(function (req, res) {
    addon.middleware(req, res, function() { res.end() }); // wire the middleware - also compatible with connect / express
}).on("listening", function()
{
    console.log("Guidebox Stremio Addon listening on "+server.address().port);
}).listen(process.env.PORT || 9005);
