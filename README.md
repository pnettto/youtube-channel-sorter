# YouTube Channel Video Sorter

A Chrome extension that filters a YouTube channel's videos by upload period and sorts them by views, date, comments or likes.

## Features

- Periods: all time, last 7 / 30 / 90 / 365 days, or a custom date range
- Sorting: views, upload date, comments, likes, comments per view, likes per view
- Filters: title text and minimum view count (e.g. `100K`)
- CSV export of the current list
- Works on a channel's `/videos` and `/streams` tabs

## Install

1. Clone or download this repository.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the `extension/` folder.

## Usage

Open a channel's **Videos** or **Live** tab and click **Sort and filter**. The extension loads the channel's video list and shows the results in a panel.

Comment and like counts are not part of the channel listing. Use the details button in the panel to fetch them. This makes one request per video, so narrow the period first on large channels.

## Notes

- Upload dates are estimated from YouTube's relative times ("2 years ago") until details are loaded, so videos near a period's edges may be misplaced.
- The extension reads YouTube's internal page data, which can change without notice.
- No data is sent anywhere other than YouTube.

## Project structure

```
extension/
  manifest.json   Manifest V3 definition
  content.js      Content script: data loading, filtering, UI
  panel.css       Panel styles
```
