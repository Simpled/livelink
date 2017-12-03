# livelink

A simple file syncing script that generates symbolic links of files and folders, allowing them to be synced to Dropbox and the like.

## Usage

Install `livelink` globally:

```
npm i -g @simpled/livelink
```

Create a `livelink.yml` file somewhere, preferrably in your sync directory, the same directory where you'd like to create your symbolic links. You can use the [sample file](/livelink.sample.yml) as your starting point. Then run:

```
livelink
```

Follow the prompts.