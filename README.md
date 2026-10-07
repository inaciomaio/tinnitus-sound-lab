# tinnitus sound lab

little browser tool for messing around with sound to see what it does to my tinnitus.

match your tinnitus pitch, play a tone that bounces between your ears, then time how long the tinnitus stays quieter after. it logs everything so you can compare settings.

try it: https://inaciomaio.github.io/tinnitus-sound-lab/

**not a medical thing.** keep the volume low. if a setting makes it louder afterwards, stop using it. if your tinnitus is in one ear, pulses, or came on suddenly, go see a doctor.

## data

all in your browser, no server. you can export/import the log (json or csv, old files still work) and optionally sync it to google drive. drive setup is in [docs/GOOGLE_DRIVE.md](docs/GOOGLE_DRIVE.md), log format in [docs/LOG_FORMAT.md](docs/LOG_FORMAT.md).

## running it

```sh
npm start   # serves site/ on localhost:8000
npm test
```

pushing to main deploys to github pages.

## license

MIT
