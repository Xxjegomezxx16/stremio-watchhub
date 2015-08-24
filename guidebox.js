var Stremio = require("stremio-addons");
var needle = require("needle");
var _ = require("lodash");

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
    name: pkg.displayName, version: pkg.version, description: pkg.description
};

var opts = { follow_max: 3, open_timeout: 10*1000, json: true };

var addon = new Stremio.Server({
    "stream.get": function(args, callback, user) {
        if (! args.query) return callback();
        needle.get(GUIDEBOX_BASE+"/search/id/imdb/"+args.query.imdb_id, opts, function(err, resp, body) {
            if (err) { console.error(err) ; return callback({ code: 0, message: "internal error" }) }
            
            var id = body.id, 
                sources = "all", // "free", "tv_everywhere", "subscription", "purchase" or "all"; TODO free
                platform = "web"; // "web", "ios", "android" or "all"

            if (args.query.hasOwnProperty("season")) {
                // TV show
                needle.get(GUIDEBOX_BASE+"/show/"+id+"/episodes/"+args.query.season+"/0/300/"+sources+"/"+platform, function(err, resp, body) {
                    if (err) { console.error(err) ; return callback({ code: 1, message: "internal error" }) }

                });
            } else {
                // Movie
            }
        });
        //return callback(null, dataset[args.query.imdb_id] || null);
    },
    "stream.find": function(args, callback, user) {
        // only "availability" is required for stream.find, but we can return the whole object
        callback(null, { items: args.items.map(function(x) { return { availability: 1 } }) });
    }
}, { /* secret: mySecret */ }, manifest);

var server = require("http").createServer(function (req, res) {
    addon.middleware(req, res, function() { res.end() }); // wire the middleware - also compatible with connect / express
}).on("listening", function()
{
    console.log("Guidebox Stremio Addon listening on "+server.address().port);
}).listen(process.env.PORT || 9005);