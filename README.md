# Poker Night – phone app

The phone version of the poker tracker. It does the same as the desktop program:
sessions, buy-ins, a countdown clock, counting chips by colour, round history,
correcting rounds and working out who pays who with as few payments as possible.

- Works offline once it has been opened once.
- Everything is saved on the phone after every tap.
- Session files can be moved between the phone and the desktop program.

## Put it online with GitHub Pages (one time, about 5 minutes)

The phone has to open the app from an `https://` address once to install it.
GitHub Pages hosts it for free. Only the app's code is put online; your poker
data stays on your phone.

1. Log in at <https://github.com> (create a free account if needed).
2. Click **+** (top right) → **New repository**.
   Name it `poker-night`, choose **Public**, and click **Create repository**.
3. On the new repository page, click **uploading an existing file**.
4. Click **choose your files**, go to this `poker-pwa` folder, select **all the files**
   (Ctrl+A): `index.html`, `app.js`, `logic.js`, `style.css`, `sw.js`,
   `manifest.webmanifest`, `icon.svg`, `icon-maskable.svg` and `README.md`.
   Click **Open**, then **Commit changes**.
5. Go to **Settings** → **Pages**. Under *Build and deployment*, choose
   **Deploy from a branch**, branch **main**, folder **/ (root)**, and click **Save**.
6. After a minute or two the page shows the address, for example
   `https://YOUR-USERNAME.github.io/poker-night/`.

## Install it on the Android phone

1. Open the address in **Chrome** on the phone.
2. Tap the **⋮** menu → **Install app** (or **Add to Home screen**).
3. Poker Night now has its own icon and opens full screen, like a normal app.

## Moving sessions between phone and computer

- **Phone → computer:** in the app, go to **Settings → Export file**. The file is
  saved in the phone's *Downloads*. Get it to the computer (for example by
  e-mail, Google Drive or a USB cable) and open it in the desktop program with
  **Session → Import session file**.
- **Computer → phone:** in the desktop program, use **Session → Export session file**,
  put the file on the phone, then in the app use **Settings → Import file**.

If the session already exists you're asked whether to replace it (the old copy is
kept as a backup) or to keep both.

## Good to know

- The data lives in Chrome's storage for this web address. Clearing Chrome's
  site data or uninstalling the app deletes it, so use **Export file** now and
  then as a backup.
- If you upload a new version to GitHub, the app picks it up automatically the
  next time it is opened with an internet connection (open it twice to see it).
- When time runs out the phone beeps and vibrates if the app is open. If the
  phone was locked, the "Time's up" message is shown when you open the app again.
  The **Keep screen on during the round** option stops the screen from turning off.
