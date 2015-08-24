var Stremio = require("../");
var stremioCentral = "http://api8.herokuapp.com";
//var mySecret = "your secret"; 

var pkg = require("./package");
var manifest = { 
    "id": "org.stremio.guidebox",
    "types": ["movie", "series"],
    "filter": { "query.imdb_id": { "$exists": true }, "query.type": { "$in":["series","movie"] } },
    name: pkg.displayName, version: pkg.version, description: pkg.description
};


var addon = new Stremio.Server({
    "stream.get": function(args, callback, user) {
        if (! args.query) return callback();
        //return callback(null, dataset[args.query.imdb_id] || null);
    },
    "stream.find": function(args, callback, user) {
        // only "availability" is required for stream.find, but we can return the whole object
        //callback(null, { items: args.items.map(function(x) { return dataset[x.query.imdb_id] || null }) });
    }
}, { /* secret: mySecret */ }, manifest);

var server = require("http").createServer(function (req, res) {
    addon.middleware(req, res, function() { res.end() }); // wire the middleware - also compatible with connect / express
}).on("listening", function()
{
    console.log("Guidebox Stremio Addon listening on "+server.address().port);
}).listen(process.env.PORT || 7000);