# WatchHub Add-on for Stremio
This Add-on allows Stremio to find a movie/tv episode from many streaming services, including Netflix, Hulu and iTunes.
Currently it selects a source in this priority: free, tv everywhere, purchase, subscription.

When Stremio allows settings for Add-ons, you would be able to select which of these types to pick first, or even a particular service (e.g. Netflix) which to pick first.

## Regions
Currently US and UK supported - will be able to set that up manually through Stremio Add-on settings.

Guidebox has launched internationally so support in this add-on is on the agenda.



## Building and deploying

``npm run docker-build``

``npm run docker-push``


## How to run?

```bash
# Clone the repo
git clone http://github.com/Stremio/stremio-watchhub
cd stremio-watchhub
npm install
GUIDEBOX_KEY="your Guidebox API KEY" node watchhub.js

# Run stremio with --services=http://localhost:9005/stremio/v1
/Applications/Stremio.app/Contents/MacOS/Electron . --services=http://localhost:9005/stremio/v1
```


## License
MIT
