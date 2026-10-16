# MEP vacancy monitor

Every hour a free GitHub Actions run opens https://apps.mep.go.cr/formulario in headless Chrome, checks **every** Dirección Regional and every page of results, and compares the vacancies against `vacantes.txt`:

- **New vacancy** (not in the file): added to the file and included in one email.
- **Vacancy gone from the site:** deleted from the file, no email.
- **Vacancy that comes back later:** it's no longer in the file, so it's treated as new and emailed again.
- **Failed or incomplete scan:** the run stops with an error and the file stays as it was. GitHub emails you about the failed run.

The first run sends one "monitoreo iniciado" email with all the vacancies open at that moment. After that, emails only go out for new ones.

## Files

| File | Purpose |
|---|---|
| `monitor.js` | Scraper, comparison, txt storage, email |
| `.github/workflows/monitor.yml` | Hourly schedule + manual run button |
| `package.json` / `package-lock.json` | Dependencies (puppeteer, nodemailer) |
| `vacantes.txt` | Created on the first run. One vacancy per line, tab-separated |

## Setup (about 10 minutes, all free)

### 1. Create a Gmail app password
1. Use a Gmail account (a new account just for alerts works well).
2. Turn on 2-Step Verification: https://myaccount.google.com/security
3. Open https://myaccount.google.com/apppasswords, create an app password named "MEP monitor" and copy the 16-character code.

### 2. Create the GitHub repository
1. Sign in at https://github.com (a free account is enough) → **New repository**.
2. Name it, for example `mep-monitor`. Choose **Public** (Actions are unlimited and free on public repos). The vacancy data is already public, and secrets stay hidden even in a public repo.
3. On the new repo page, click **uploading an existing file**. Drag in `monitor.js`, `package.json`, `package-lock.json`, `.gitignore` and `README.md` → **Commit changes**.
4. The workflow file needs its folder path: **Add file → Create new file**. For the name, type `.github/workflows/monitor.yml` (the slashes create the folders). Paste in the contents of `monitor.yml` → **Commit changes**.

### 3. Add the secrets
Go to **Settings → Secrets and variables → Actions → New repository secret** and create:

| Name | Value |
|---|---|
| `GMAIL_USER` | the Gmail address from step 1 |
| `GMAIL_APP_PASSWORD` | the 16-character app password |
| `MAIL_TO` | where alerts go (optional; defaults to `GMAIL_USER`; separate several addresses with commas) |

### 4. Allow the workflow to save the file
**Settings → Actions → General → Workflow permissions** → choose **Read and write permissions** → Save.

### 5. Test, then let it run
Open the **Actions** tab (click "I understand… enable" if GitHub asks) → **Monitor vacantes MEP** → **Run workflow**:

1. `dry-run`: check the log. It should list every region and something like "Escaneo completo: 18 vacantes". Nothing is emailed or saved.
2. `test-email`: you should get a "[PRUEBA]" email. Nothing is saved.
3. `normal`: you get the "monitoreo iniciado" email, and `vacantes.txt` appears in the repo.

After that it runs on its own every hour. Your computer doesn't need to be on.

## Simulating a new vacancy (exactly one email)
1. In the repo, open `vacantes.txt` → pencil icon → delete one vacancy line → Commit.
2. Actions → Run workflow → `normal`.
3. You get **one** email, "MEP Alert: 1 nueva plaza disponible", for that vacancy, and the line is back in the file.
4. Run it again: no email (no changes).

## Notes
- **Timing:** GitHub's scheduled runs can start 5–30 minutes late when GitHub is busy. Runs never overlap.
- **Cost:** about 1–2 minutes per run, roughly 720 runs a month. Free and unlimited on a public repo. A private repo would use about 1,000–1,500 of the 2,000 free minutes a month.
- **Inactivity:** GitHub turns off schedules in a public repo after 60 days with no repo activity. The bot's commits to `vacantes.txt` count, so this only happens if no vacancy changes for 60 days. If it does, re-enable the schedule in the Actions tab.
- **Vacancy key:** a vacancy is identified by its number plus its visible fields (institution, lessons, dates…). If MEP edits a vacancy's dates or lessons, it shows up as new and the old line is removed.
- **No vacancies at all:** if the site ever lists zero regions, the run fails on purpose and doesn't wipe the file. An empty page usually means the site broke, not that there are truly no vacancies.
