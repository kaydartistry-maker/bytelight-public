# The Android app

The phone app can be installed as a real Android app. It is a thin native
shell around the phone app the house already serves: the shell opens your
house's https address, so every UI change ships with a normal deploy and the
APK only needs rebuilding when native pieces change. What the shell adds over
the browser: calls that keep going with the screen off (the voice dock and its
notification), a back button that behaves, and the native permissions.

The APK is built by GitHub, not on the VM (Actions → **Phone APK**).

## One-time setup

1. **The address.** Repo Settings → Secrets and variables → Actions →
   **Variables** → New variable `PHONE_SERVER_URL`, value: the https address
   you open the phone app at, ending in `/phone/` while both front ends run
   (after the flip moves the phone to `/`, change it and rebuild). It must be
   https: Android's WebView refuses the mic and location on plain http.

2. **Try it first (optional).** You can build without a signing key: the
   run produces a debug APK. It installs and works, but each new debug build
   is signed with a fresh key, so it has to be uninstalled before the next
   one goes on.

3. **Your signing key (do this once, keep it forever).** On any computer
   with Java:

   ```sh
   keytool -genkey -v -keystore bytelight-release.jks -alias bytelight \
     -keyalg RSA -keysize 2048 -validity 10000
   base64 -w0 bytelight-release.jks > bytelight-release.b64   # macOS: base64 -i bytelight-release.jks
   ```

   Then add four repo **secrets**: `ANDROID_KEYSTORE_B64` (the contents of the
   .b64 file), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`bytelight`)
   and `ANDROID_KEY_PASSWORD`. Back the .jks and both passwords up somewhere
   safe. Lose them and the only way to update the app is to uninstall it.
   The key never goes in the repo.

## Building and installing

1. GitHub → Actions → **Phone APK** → Run workflow.
2. When it finishes, download **bytelight-phone-apk** from the run's
   artifacts (a zip with the APK inside) to the phone.
3. Open the APK. Android asks to allow installs from that app (Files or
   Chrome) the first time; allow it.
4. First launch: sign in as usual, then grant microphone, notifications and
   location when asked. For the call dock over other apps, allow "Display
   over other apps" in the app's system settings.

## Push to the app (optional)

The house sends every notification to the browser (web push) and, once this
is set up, to the app too.

1. Firebase console → a project → Add app → Android, package name
   `com.bytelight.phone` → download `google-services.json`.
2. Repo Settings → Secrets and variables → Actions → **Secrets** → New
   secret `GOOGLE_SERVICES_JSON`, value: the whole contents of that file.
   Then run **Phone APK** again and install the new build.
3. Firebase → Project settings → Service accounts → Generate new private
   key. In the app: Settings → Secrets → **Firebase service account**, paste
   the whole file. It takes effect at once (no restart). This one is a real
   secret: it never goes in the repo or a chat.
4. In the app's Settings, switch notifications off and on again so the phone
   registers with the house.

## When it crashes

The shell posts its crash on the way out; it lands in `app/crashes.log` beside
the house database (bounded, one entry per crash). Send that file along with
what you were doing.

## Not in yet

- **Update card**: the house answers `/api/app/version`, but only offers an
  update once an APK and its `version.json` are staged in `app/` beside the
  house database; GitHub builds don't stage themselves there yet.
- **Toys (Lovense)** and arrival alerts at your places come with their own
  slices.
