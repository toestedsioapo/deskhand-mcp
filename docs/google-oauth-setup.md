# Google Cloud OAuth setup (your own client, Testing mode)

Status: written with the M3 plan on 2026-11-11. Parts 1 to 5 can be done today. Part 6 needs `deskhand auth`, which arrives with M3b; until then the commands there do not exist.

Deskhand never ships an OAuth client. You create one in your own Google Cloud project, keep it in Testing mode, and add yourself as the only test user. Nobody else can sign in with it, and Google does not need to verify it.

Console labels were checked against Google's Workspace developer guides on 2026-11-11 ("Configure the OAuth consent screen" and "Create access credentials"). Google renames these pages from time to time; if a label differs, look for the nearest match under **Google Auth platform**.

## What you will end up with

- A Google Cloud project with only the Google Calendar API enabled.
- An OAuth consent configuration: user type External, publishing status Testing, one test user (you).
- One OAuth client of type **Desktop app**, downloaded as a JSON file and stored at `%LOCALAPPDATA%\deskhand\client_secret.json`.
- Scopes, the minimum for M3:

| When | Scope | What it allows |
|---|---|---|
| Always (read tools) | `https://www.googleapis.com/auth/calendar.readonly` | see calendars, events and free/busy |
| Only after `deskhand auth upgrade`, with `DESKHAND_ALLOW_WRITES=1` | `https://www.googleapis.com/auth/calendar.events` | create and edit events |

No Gmail scope is used in M3. `gmail.send` and `gmail.modify` are never requested.

## 1. Create a project

1. Open <https://console.cloud.google.com/> and sign in with the Google account whose calendar you want to use.
2. Click the project picker at the top, then **New project**.
3. Name it (for example `deskhand-local`). Leave the organisation as it is. Click **Create**.
4. Make sure the new project is selected in the project picker before you continue. Every step below applies to the selected project.

## 2. Enable the Google Calendar API

1. Menu > **APIs & Services** > **Library**.
2. Search for **Google Calendar API**, open it, click **Enable**.
3. Do not enable anything else. The Gmail API is not needed until M4.

## 3. Configure the consent screen

1. Menu > **Google Auth platform** > **Branding**.
2. If you see "Google Auth platform not configured yet", click **Get Started**.
3. **App Information:** app name (for example `Deskhand local`) and your email as the user support email. Click **Next**.
4. **Audience:** choose **External**. Click **Next**. (Internal only exists for Google Workspace organisations.)
5. **Contact information:** your email. Click **Next**.
6. **Finish:** read and accept the Google API Services User Data Policy, then **Continue** and **Create**.

Leave the publishing status at **Testing**. Do not click **Publish app**: publishing is what triggers Google's verification process.

## 4. Add yourself as a test user and declare the scopes

1. **Google Auth platform** > **Audience** > **Test users** > **Add users**. Enter the Google account you will sign in with. **Save**.
2. **Google Auth platform** > **Data Access** > **Add or Remove Scopes**.
3. In the filter, find and tick `.../auth/calendar.readonly`. If you plan to enable writes later, also tick `.../auth/calendar.events`. If a scope is not in the list, paste its full URL from the table above into **Manually add scopes**.
4. Click **Update**, then **Save**.

Declaring a scope here does not grant it. Deskhand asks for the read scope at login and for the write scope only when you run `deskhand auth upgrade`.

## 5. Create the Desktop client and store the file

1. **Google Auth platform** > **Clients** > **Create Client**.
2. **Application type:** **Desktop app**. Not "Web application": Deskhand's loader rejects that kind.
3. Name it (for example `deskhand-cli`). The name is only shown in the console.
4. If an option "Use this client for an AI-powered agent" appears, leave it unticked.
5. Click **Create**.
6. Download the JSON now, from the dialog that appears (**Download JSON**). Google may show the client secret only at creation time; if you miss it, delete the client and create a new one.
7. Move the file into Deskhand's config directory under the exact name `client_secret.json`. PowerShell:

   ```powershell
   New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\deskhand" | Out-Null
   Move-Item "$env:USERPROFILE\Downloads\client_secret_*.json" "$env:LOCALAPPDATA\deskhand\client_secret.json"
   Get-Content "$env:LOCALAPPDATA\deskhand\client_secret.json" | Select-String '"installed"'
   ```

   The last command must print a line. If it prints nothing, the file is not a Desktop-app client.

   On Linux the directory is `~/.config/deskhand/`, on macOS `~/Library/Application Support/deskhand/`. If you set `DESKHAND_HOME`, use that directory instead.

Rules for this file:

- Never put it in a repository. The repo's `.gitignore` covers `client_secret*.json`, `credentials*.json` and `token*.json` as a backstop, but the file should not be inside the repo folder at all.
- Do not paste its contents into a chat or an AI client.
- Keep the directory inside your user profile (on Windows the profile ACL is what protects it).

## 6. Sign in (from M3b)

In a real terminal, with the server not needed:

```powershell
$env:DESKHAND_PROVIDER = 'google'
deskhand auth login
```

1. The command prints a link. Open it in your browser.
2. Pick your account. Google shows "Google hasn't verified this app". That is expected for your own client in Testing mode: click **Continue**.
3. The consent page must list **only** "See and download any calendar you can access using your Google Calendar" (wording may vary slightly). If it lists anything about Gmail, or about editing events, stop and tell me: that would be a bug.
4. Approve. The browser shows a short "you can close this tab" page, and the terminal prints the granted scope.
5. `deskhand auth status` shows the scopes and roughly how many days are left.

To allow writes later:

```powershell
$env:DESKHAND_ALLOW_WRITES = '1'
deskhand auth upgrade
```

The consent page then also lists "View and edit events on all your calendars". `upgrade` refuses to run unless `DESKHAND_ALLOW_WRITES=1` is set.

## Things to know

- **Sign-in expires after about 7 days.** In Testing mode with an External user type, Google expires refresh tokens after 7 days. When that happens every Google-backed tool answers `AUTH_REQUIRED`; run `deskhand auth login` again (and `upgrade` if you use writes). `deskhand auth status` shows an estimate.
- **Only your test users can sign in.** Anyone else gets "access blocked".
- **Where the token lives:** `token.json` next to `client_secret.json`. It is the sensitive file. It is never written to the ledger or printed.
- **To revoke access:** <https://myaccount.google.com/permissions>, find your app name, **Remove access**. Then delete `token.json`.
- **To undo everything:** delete the OAuth client under **Clients**, or delete the whole project under **IAM & Admin** > **Settings** > **Shut down**.
- **Costs:** none. The Calendar API has no charge at this usage; no billing account is needed.

## Troubleshooting

| What you see | Cause | Fix |
|---|---|---|
| "Access blocked: … has not completed the Google verification process" | you are not in the test user list | Part 4, step 1 |
| `Error 400: redirect_uri_mismatch` | the client is not a Desktop app | create a new client of type **Desktop app** (Part 5) |
| "Google Calendar API has not been used in project … or it is disabled" | API not enabled in this project | Part 2, with the right project selected |
| `AUTH_REQUIRED` a week after it worked | the 7-day Testing-mode expiry | `deskhand auth login` |
| `AUTH_REQUIRED … deskhand auth upgrade` on `action_apply` | the token has only the read scope | set `DESKHAND_ALLOW_WRITES=1`, run `deskhand auth upgrade` |
| Login says no refresh token was returned | Google remembers an earlier grant | remove the app at <https://myaccount.google.com/permissions>, then log in again |
