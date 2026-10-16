// Monitor de vacantes MEP (https://apps.mep.go.cr/formulario)
// Cada ejecución: recorre TODAS las regionales y todas las páginas, compara con vacantes.txt,
// envía un correo con las vacantes nuevas, agrega las nuevas y elimina las que ya no aparecen.
//
// Modos (variable MODE):
//   normal     -> escanea, envía correo si hay nuevas y actualiza vacantes.txt
//   dry-run    -> escanea y muestra las diferencias; NO envía correo ni modifica vacantes.txt
//   test-email -> escanea y envía un correo de prueba con lo encontrado; NO modifica vacantes.txt
//
// Seguridad: si el escaneo falla o queda incompleto, el proceso termina con error y
// vacantes.txt NO se toca (nunca se interpreta un fallo como "no hay vacantes").

import fs from "node:fs";
import puppeteer from "puppeteer";
import nodemailer from "nodemailer";

const SITE_URL = "https://apps.mep.go.cr/formulario";
const STATE_FILE = process.env.STATE_FILE || "vacantes.txt";
const MODE = (process.env.MODE || "normal").trim().toLowerCase();
const SCAN_FIXTURE = process.env.SCAN_FIXTURE; // opcional: JSON con un escaneo simulado (para pruebas)
const TZ = "America/Costa_Rica";
const MAX_ATTEMPTS = 3;
const MAX_PAGES_PER_REGION = 50;

const FIELDS = ["vacante", "regional", "clasePuesto", "especialidad", "institucion", "lecciones", "rige", "vence"];
const HEADER = "# " + [...FIELDS, "detectada"].join("\t");

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => String(s ?? "").replace(/[\t\r\n]+/g, " ").replace(/\s+/g, " ").trim();
const nowCR = () =>
  new Intl.DateTimeFormat("es-CR", { timeZone: TZ, dateStyle: "short", timeStyle: "short" }).format(new Date());

// La clave identifica una vacante. Se usa el número de vacante + los datos visibles, porque el
// mismo número puede aparecer en más de una fila (p. ej. con distinta institución o fechas).
const keyOf = (v) => FIELDS.map((f) => clean(v[f]).toUpperCase()).join("|");

// ---------------------------------------------------------------- almacenamiento (txt)

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return null; // primera ejecución
  const map = new Map();
  for (const line of fs.readFileSync(STATE_FILE, "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    const parts = line.split("\t");
    const v = {};
    FIELDS.forEach((f, i) => (v[f] = parts[i] ?? ""));
    v.detectada = parts[FIELDS.length] ?? "";
    map.set(keyOf(v), v);
  }
  return map;
}

function saveState(map) {
  const rows = [...map.values()].sort(
    (a, b) => a.regional.localeCompare(b.regional) || a.vacante.localeCompare(b.vacante),
  );
  const body = rows.map((v) => [...FIELDS, "detectada"].map((f) => clean(v[f])).join("\t"));
  fs.writeFileSync(STATE_FILE, [HEADER, ...body].join("\n") + "\n", "utf8");
}

// ---------------------------------------------------------------- scraping

// "Regional Educación San Jose - Central" y "Direc. Regional Educacion San Jose - Central"
// -> "SAN JOSE - CENTRAL"
const regionKey = (s) => {
  const n = clean(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
  const i = n.lastIndexOf("EDUCACION");
  return (i >= 0 ? n.slice(i + "EDUCACION".length) : n).trim();
};

// Se ejecuta dentro del navegador: lee la tabla visible usando las cabeceras.
function readTableInPage() {
  const norm = (s) =>
    (s || "").replace(/ /g, " ").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim();
  const loading = !!document.querySelector(".mud-table-loading-row");
  const headers = [...document.querySelectorAll("table thead th")].map((th) => norm(th.textContent));
  const rows = [...document.querySelectorAll("table tbody tr")]
    .map((tr) => {
      const cells = [...tr.querySelectorAll("td")];
      const o = {};
      headers.forEach((h, i) => h && (o[h] = (cells[i]?.textContent || "").replace(/\s+/g, " ").trim()));
      return o;
    })
    .filter((o) => /^\d+$/.test(o.VACANTE || ""));
  return { loading, headers, rows };
}

async function waitForRegionTable(page, rKey, previousFirstId = null, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const t = await page.evaluate(readTableInPage);
    if (!t.loading && t.rows.length > 0) {
      const allMatch = t.rows.every((r) => regionKey(r["DIRECCION REGIONAL"]) === rKey);
      const changed = previousFirstId === null || t.rows[0].VACANTE !== previousFirstId;
      if (allMatch && changed) {
        await sleep(400); // margen para que termine de pintar
        return page.evaluate(readTableInPage);
      }
    }
    await sleep(300);
  }
  throw new Error(`La tabla de la regional "${rKey}" no cargó a tiempo`);
}

async function scrapeOnce() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    await page.goto(SITE_URL, { waitUntil: "networkidle2", timeout: 60000 });
    await page.waitForSelector("select");
    await page.waitForFunction(() => document.querySelector("select")?.options.length > 1, { timeout: 30000 });

    const regions = await page.evaluate(() =>
      [...document.querySelector("select").options]
        .filter((o) => o.value && o.value !== "0")
        .map((o) => ({ value: o.value, text: o.textContent.trim() })),
    );
    if (regions.length === 0) throw new Error("El selector no tiene regionales (posible cambio en el sitio)");
    log(`Regionales encontradas: ${regions.length}`);

    const all = [];
    for (const region of regions) {
      const rKey = regionKey(region.text);
      let table = null;
      // Blazor puede tardar en conectar: si el primer "change" no surte efecto, se reintenta una vez.
      for (let tryNo = 1; tryNo <= 2 && !table; tryNo++) {
        await page.evaluate((val) => {
          const s = document.querySelector("select");
          s.value = val;
          s.dispatchEvent(new Event("change", { bubbles: true }));
        }, region.value);
        try {
          table = await waitForRegionTable(page, rKey);
        } catch (e) {
          if (tryNo === 2) throw e;
          log(`Reintentando regional ${region.text}...`);
        }
      }
      if (!table.headers.includes("VACANTE") || !table.headers.includes("CLASE DE PUESTO")) {
        throw new Error(`Cambió la estructura de la tabla. Cabeceras: ${table.headers.join(", ")}`);
      }

      let pageNo = 1;
      let regionRows = [...table.rows];
      while (pageNo < MAX_PAGES_PER_REGION) {
        const next = await page.$('button[aria-label="Next page"]:not([disabled])');
        if (!next) break;
        const firstId = table.rows[0].VACANTE;
        await next.click();
        pageNo++;
        table = await waitForRegionTable(page, rKey, firstId);
        regionRows.push(...table.rows);
      }
      log(`${region.text}: ${regionRows.length} vacantes en ${pageNo} página(s)`);

      for (const r of regionRows) {
        all.push({
          vacante: r.VACANTE,
          regional: r["DIRECCION REGIONAL"],
          clasePuesto: r["CLASE DE PUESTO"],
          especialidad: r.ESPECIALIDAD,
          institucion: r.INSTITUCION,
          lecciones: r.LECCIONES,
          rige: r.RIGE,
          vence: r.VENCE,
        });
      }
    }
    return all;
  } finally {
    await browser.close();
  }
}

async function scrapeWithRetries() {
  if (SCAN_FIXTURE) {
    log(`Usando escaneo simulado: ${SCAN_FIXTURE}`);
    return JSON.parse(fs.readFileSync(SCAN_FIXTURE, "utf8"));
  }
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await scrapeOnce();
    } catch (e) {
      lastErr = e;
      log(`Intento ${attempt}/${MAX_ATTEMPTS} falló: ${e.message}`);
      if (attempt < MAX_ATTEMPTS) await sleep(30000 * attempt); // 30 s, 60 s
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------- correo

const esc = (s) => clean(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function buildEmail(list, title) {
  const cols = [
    ["vacante", "Vacante"], ["regional", "Dirección Regional"], ["clasePuesto", "Clase de Puesto"],
    ["especialidad", "Especialidad"], ["institucion", "Institución"], ["lecciones", "Lecciones"],
    ["rige", "Rige"], ["vence", "Vence"], ["detectada", "Detectada (CR)"],
  ];
  const th = cols.map(([, h]) => `<th style="border:1px solid #ccc;padding:6px;background:#003366;color:#fff;text-align:left">${h}</th>`).join("");
  const trs = list
    .map((v) => "<tr>" + cols.map(([k]) => `<td style="border:1px solid #ccc;padding:6px">${esc(v[k])}</td>`).join("") + "</tr>")
    .join("");
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px">
<h2 style="color:#003366">${esc(title)}</h2>
<table style="border-collapse:collapse;font-size:13px"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>
<p>Aplicar en: <a href="${SITE_URL}">${SITE_URL}</a></p>
<p style="color:#777;font-size:11px">Aviso automático, no oficial del MEP.</p></div>`;
  const text =
    title + "\n\n" +
    list.map((v) => cols.map(([k, h]) => `${h}: ${clean(v[k])}`).join("\n")).join("\n\n") +
    `\n\nAplicar en: ${SITE_URL}\n`;
  return { html, text };
}

async function sendEmail(subject, list, title) {
  const { GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;
  const to = process.env.MAIL_TO || GMAIL_USER;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) throw new Error("Faltan los secretos GMAIL_USER / GMAIL_APP_PASSWORD");
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD.replace(/\s+/g, "") },
  });
  const { html, text } = buildEmail(list, title);
  await transporter.sendMail({ from: `MEP Alertas <${GMAIL_USER}>`, to, subject, html, text });
  log(`Correo enviado a ${to}: "${subject}"`);
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- flujo principal

async function main() {
  log(`Modo: ${MODE}`);
  if (!["normal", "dry-run", "test-email"].includes(MODE)) throw new Error(`MODE inválido: ${MODE}`);

  const scanned = await scrapeWithRetries();
  if (!Array.isArray(scanned) || scanned.length === 0) {
    throw new Error("El escaneo no devolvió vacantes; no se modifica nada");
  }

  // Quitar duplicados exactos dentro del mismo escaneo
  const current = new Map();
  for (const v of scanned) current.set(keyOf(v), v);
  log(`Escaneo completo: ${current.size} vacantes`);

  const stored = loadState();
  const firstRun = stored === null;
  const previous = stored ?? new Map();
  const stamp = nowCR();

  const added = [...current].filter(([k]) => !previous.has(k)).map(([, v]) => ({ ...v, detectada: stamp }));
  const removed = [...previous].filter(([k]) => !current.has(k)).map(([, v]) => v);

  log(`Nuevas: ${added.length} | Eliminadas: ${removed.length} | Sin cambios: ${current.size - added.length}`);
  added.forEach((v) => log(`  + ${v.vacante} ${v.regional} | ${v.clasePuesto} | ${v.especialidad} | ${v.institucion}`));
  removed.forEach((v) => log(`  - ${v.vacante} ${v.regional} | ${v.clasePuesto} | ${v.especialidad} | ${v.institucion}`));

  if (MODE === "dry-run") {
    log("dry-run: no se envía correo ni se modifica el archivo.");
    return;
  }

  if (MODE === "test-email") {
    const list = [...current.values()].map((v) => ({ ...v, detectada: stamp }));
    await sendEmail(`[PRUEBA] MEP Alert: ${plural(list.length, "plaza disponible", "plazas disponibles")}`, list,
      `Correo de prueba: ${plural(list.length, "plaza disponible", "plazas disponibles")} en este momento`);
    log("test-email: no se modifica el archivo.");
    return;
  }

  // Correo ANTES de guardar: si el envío falla, el proceso termina con error, el archivo no cambia
  // y la siguiente ejecución vuelve a intentar avisar de las mismas vacantes.
  if (firstRun) {
    await sendEmail(`MEP Alert: monitoreo iniciado (${plural(added.length, "plaza disponible", "plazas disponibles")})`,
      added, `Monitoreo iniciado. Estas son las ${plural(added.length, "plaza disponible", "plazas disponibles")} hoy. Desde ahora solo recibirás las nuevas.`);
  } else if (added.length > 0) {
    await sendEmail(`MEP Alert: ${plural(added.length, "nueva plaza disponible", "nuevas plazas disponibles")}`,
      added, `${plural(added.length, "nueva plaza disponible", "nuevas plazas disponibles")}`);
  }

  if (added.length || removed.length || firstRun) {
    const next = new Map();
    for (const [k] of current) next.set(k, previous.get(k) ?? added.find((v) => keyOf(v) === k));
    saveState(next);
    log(`${STATE_FILE} actualizado (${next.size} vacantes).`);
  } else {
    log("Sin cambios.");
  }
}

main().catch((e) => {
  console.error(new Date().toISOString(), "ERROR:", e.stack || e.message);
  process.exit(1);
});
