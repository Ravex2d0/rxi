const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const infoBox = document.getElementById("infoBox");
const progressBar = document.getElementById("progressBar");

const scanModeSelect = document.getElementById("scanMode");
const creatorInput = document.getElementById("creatorName");

document.getElementById("rxiFile").onchange = e => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => parseRXI(new Uint8Array(r.result));
  r.readAsArrayBuffer(f);
};

async function parseRXI(b) {
  let p = 0;

  // SOF
  if (b[p++] !== 0x02 || b[p++] !== 0xD0) return alert("Invalid SOF");
  if (str(b, p, 3) !== "RXI") return alert("Invalid RXI");
  p += 3;
  p += 3;

  let creator = "N/A";
  let dateStr = "N/A";

  // FINF
  if (str(b, p, 4) === "FINF") {
    p += 4;
    const len = b[p++];
    creator = str(b, p, len);
    p += len;

    const day = b[p++];
    const month = b[p++];
    const year = (b[p++] << 8) | b[p++];

    dateStr = `${String(day).padStart(2, "0")}-${String(month).padStart(2, "0")}-${year}`;
  }

  // HDR
  if (str(b, p, 3) !== "HDR") return alert("HDR missing");
  p += 3;

  const mode = b[p++];
  const w = (b[p++] << 8) | b[p++];
  const h = (b[p++] << 8) | b[p++];
  const scanMode = b[p++];

  canvas.width = w;
  canvas.height = h;

  infoBox.innerHTML = `
    Creator: ${creator}<br>
    Date: ${dateStr}<br>
    Resolution: ${w}×${h}<br>
    Mode: ${mode}<br>
    ScanMode: ${scanMode}
  `;

  const img = ctx.createImageData(w, h);
  img.data.fill(0);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;

  // PDAT
  if (str(b, p, 4) !== "PDAT") return alert("PDAT missing");
  p += 4;

  const compressed = b[p++];

  const dataLength =
    (b[p++] * 16777216) +
    (b[p++] << 16) +
    (b[p++] << 8) +
    b[p++];

  let pdat = b.slice(p, p + dataLength);
  p += dataLength;

  if (compressed === 1) {
    pdat = await inflateData(pdat);
  }

  let pd = pdat;
  let pdp = 0;

  const total = w * h;

  progressBar.value = 0;

  if (scanMode === 1) {
    for (let px = 0; px < total; px++) {
      let r = 0, g = 0, b = 0, a = 255;

      if (mode === 1) r = g = b = pd[pdp++];
      else if (mode === 2) { r = pd[pdp++]; g = pd[pdp++]; b = pd[pdp++]; }
      else if (mode === 3) { r = pd[pdp++]; g = pd[pdp++]; b = pd[pdp++]; a = pd[pdp++]; }
      else if (mode === 4) { r = g = b = pd[pdp++]; a = pd[pdp++]; }

      const i = px * 4;
      img.data.set([r, g, b, a], i);

      if (px % 1000 === 0) progressBar.value = (px / total) * 100;
    }
  } else if (scanMode === 2) {
    let px = 0;

    while (pdp < pd.length && px < total) {

      let r = 0, g = 0, b = 0, a = 255;

      if (mode === 1) r = g = b = pd[pdp++];
      else if (mode === 2) { r = pd[pdp++]; g = pd[pdp++]; b = pd[pdp++]; }
      else if (mode === 3) { r = pd[pdp++]; g = pd[pdp++]; b = pd[pdp++]; a = pd[pdp++]; }
      else if (mode === 4) { r = g = b = pd[pdp++]; a = pd[pdp++]; }

      if (pdp + 1 >= pd.length) break;

      const byte1 = pd[pdp++];
      const byte2 = pd[pdp++];

      const isFill = (byte1 & 0x80) !== 0;
      const count = ((byte1 & 0x7F) << 8) | byte2;

      if (isFill) {
        for (let i = 0; i < count && px < total; i++, px++) {
          const idx = px * 4;
          img.data.set([r, g, b, a], idx);
        }
      } else {
        px += count;
      }
    }
  } else {
    return alert("Unknown scan mode");
  }

  ctx.putImageData(img, 0, 0);
  progressBar.value = 100;
}

document.getElementById("convert").onclick = async () => {
  const files = document.getElementById("pngFile").files;
  if (!files.length) return alert("PNG belum dipilih");

  const scanMode = parseInt(scanModeSelect.value);
  const creator = creatorInput.value.trim();

  if (typeof JSZip === "undefined") {
    await loadJSZip();
  }
  const zip = new JSZip();

  for (let fIndex = 0; fIndex < files.length; fIndex++) {
    const f = files[fIndex];
    await new Promise(resolve => {
      const img = new Image();
      img.onload = async () => {
        const rxiData = await pngToRXI(img, scanMode, creator);
        zip.file(f.name.replace(/\.[^/.]+$/, ".rxi"), rxiData);
        resolve();
      };
      img.src = URL.createObjectURL(f);
    });
    progressBar.value = ((fIndex + 1) / files.length) * 100;
  }

  zip.generateAsync({ type: "blob" }).then(blob => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "batch_rxi.zip";
    a.click();
    progressBar.value = 100;
  });
};

async function pngToRXI(img, scanMode, creator) {
  console.log('conversion started...');
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const cx = c.getContext("2d");
  cx.drawImage(img, 0, 0);

  const d = cx.getImageData(0, 0, c.width, c.height).data;

  let hasAlpha = false, allGray = true;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] !== 255) hasAlpha = true;
    if (!(d[i] === d[i + 1] && d[i] === d[i + 2])) allGray = false;
  }

  let mode;
  if (!hasAlpha && !allGray) mode = 2;
  else if (!hasAlpha && allGray) mode = 1;
  else if (hasAlpha && allGray) mode = 4;
  else mode = 3;

  const total = d.length / 4;

  if (scanMode === 0) {
    scanMode = smartDetectScanMode(d, total);
  }

  const header = [];

  // SOF
  header.push(0x02, 0xD0, ...asc("RXI"), 0xE2, 0x88, 0x9E);

  // FINF
  if (creator) {
    header.push(...asc("FINF"));
    header.push(creator.length);
    header.push(...asc(creator));
    const now = new Date();
    const year = now.getFullYear();
    header.push(now.getDate(), now.getMonth() + 1, (year >> 8) & 255, year & 255);
  }

  // HDR
  header.push(
    ...asc("HDR"), mode,
    c.width >> 8, c.width & 255,
    c.height >> 8, c.height & 255,
    scanMode
  );

  // PDAT header
  header.push(...asc("PDAT"));

  const pdatOut = [];

  if (scanMode === 1) {
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i+1], b = d[i+2], a = d[i+3];
      if (mode === 1) pdatOut.push(r);
      else if (mode === 2) pdatOut.push(r, g, b);
      else if (mode === 3) pdatOut.push(r, g, b, a);
      else if (mode === 4) pdatOut.push(r, a);
    }
  } else if (scanMode === 2) {
    let i = 0;
    while (i < total) {
      const idx = i * 4;
      const r = d[idx], g = d[idx+1], b = d[idx+2], a = d[idx+3];
      let fillCount = 0;

      while (i < total) {
        const id = i * 4;
        if (d[id] !== r || d[id+1] !== g || d[id+2] !== b || d[id+3] !== a || fillCount >= 32767) break;
        fillCount++;
        i++;
      }

      if (mode === 1) pdatOut.push(r);
      else if (mode === 2) pdatOut.push(r, g, b);
      else if (mode === 3) pdatOut.push(r, g, b, a);
      else if (mode === 4) pdatOut.push(r, a);

      pdatOut.push(...makeSegment(true, fillCount));
    }
  }

  const compressedData = await deflateData(new Uint8Array(pdatOut));

  const pdatMeta = [
    1,
    (compressedData.length >> 24) & 255,
    (compressedData.length >> 16) & 255,
    (compressedData.length >> 8) & 255,
    compressedData.length & 255
  ];

  const footer = [...asc("END "), 0xF0, 0x9F, 0x97, 0xBF];

  const headerArr = new Uint8Array(header);
  const pdatMetaArr = new Uint8Array(pdatMeta);
  const footerArr = new Uint8Array(footer);

  const totalLength = headerArr.length + pdatMetaArr.length + compressedData.length + footerArr.length;
  const result = new Uint8Array(totalLength);

  let offset = 0;
  result.set(headerArr, offset);      offset += headerArr.length;
  result.set(pdatMetaArr, offset);    offset += pdatMetaArr.length;
  result.set(compressedData, offset); offset += compressedData.length;
  result.set(footerArr, offset);

  return result;
}

// Utils
function asc(s) { return [...s].map(c => c.charCodeAt(0)); }
function str(b, o, l) { return String.fromCharCode(...b.slice(o, o + l)); }
function makeSegment(isFill, count) {
  const byte1 = (isFill ? 0x80 : 0x00) | ((count >> 8) & 0x7F);
  const byte2 = count & 0xFF;
  return [byte1, byte2];
}
async function deflateData(uint8) {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  writer.write(uint8);
  writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
async function inflateData(uint8) {
  const ds = new DecompressionStream("deflate");
  const writer = ds.writable.getWriter();
  writer.write(uint8);
  writer.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}
function smartDetectScanMode(d, total, sampleSize = 2000) {
  const step = Math.max(1, Math.floor(total / sampleSize));
  let sameAsNext = 0;
  let checked = 0;

  for (let i = 0; i < total - 1; i += step) {
    const idx = i * 4;
    const nxt = (i + 1) * 4;

    if (
      d[idx]   === d[nxt]   &&
      d[idx+1] === d[nxt+1] &&
      d[idx+2] === d[nxt+2] &&
      d[idx+3] === d[nxt+3]
    ) sameAsNext++;

    checked++;
  }

  const runRatio = sameAsNext / checked;

  console.log(`[Smart Mode] Run ratio: ${(runRatio * 100).toFixed(1)}% → ScanMode ${runRatio > 0.4 ? 2 : 1}`);
  return runRatio > 0.4 ? 2 : 1;
}

function loadJSZip() {
  return new Promise(resolve => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
    s.onload = resolve;
    document.head.appendChild(s);
  });
}

document.getElementById("downloadPNG").onclick = () => {
  canvas.toBlob(blob => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "image.png";
    a.click();
  }, "image/png");
};
