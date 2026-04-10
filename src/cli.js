#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const APP_NAME = "winmu";
const APP_VERSION = "1.0.0";
const BASE_DIR = "/etc/winmu";
const OS_DIR = path.join(BASE_DIR, "os");
const VIRTIO_DIR = path.join(BASE_DIR, "virtio");
const MANIFEST_DIR = path.join(BASE_DIR, "manifests");
const CONTAINERS_DIR = path.join(BASE_DIR, "containers");
const TMP_DIR = path.join(BASE_DIR, "tmp");
const CONFIG_PATH = path.join(BASE_DIR, "config.json");
const SYSTEMD_DIR = "/etc/systemd/system";
const HOME_DIR = os.homedir();

const DEFAULT_CONFIG = {
  github: {
    owner: "alpian9890",
    repo: "windows10-qemu",
    releaseTag: "assets"
  },
  os: {
    manifestName: "windows10-os-manifest.json",
    archiveName: "windows10-os.tar.zst",
    extractedIsoName: "windows10.iso",
    extractedImgName: "windows10.img"
  },
  virtio: {
    manifestName: "virtio-win-manifest.json",
    assetName: "virtio-win.iso",
    targetName: "virtio-win.iso"
  },
  packaging: {
    partSize: "1900M"
  }
};

const VM_PROFILES = {
  small: { label: "Small", ramMb: 2048, cpu: 1, diskGb: 25 },
  medium: { label: "Medium", ramMb: 4096, cpu: 2, diskGb: 40 },
  large: { label: "Large", ramMb: 8192, cpu: 4, diskGb: 80 }
};

function main() {
  try {
    ensureRoot();
    initializeLayout();

    const [command, ...rest] = process.argv.slice(2);
    if (!command) {
      runInteractiveMenu();
      return;
    }

    switch (command) {
      case "menu":
        runInteractiveMenu();
        return;
      case "setup-qemu":
        setupQemu();
        return;
      case "download-os":
        downloadOs(parseArgs(rest));
        return;
      case "download-virtio":
        downloadVirtio(parseArgs(rest));
        return;
      case "create-container":
        createContainer(parseArgs(rest));
        return;
      case "delete-container":
        deleteContainer(parseArgs(rest));
        return;
      case "pack-os-assets":
        packOsAssets(parseArgs(rest));
        return;
      case "show-config":
        console.log(JSON.stringify(loadConfig(), null, 2));
        return;
      case "version":
      case "--version":
      case "-v":
        console.log(`${APP_NAME} ${APP_VERSION}`);
        return;
      default:
        fatal(`Command tidak dikenal: ${command}`);
    }
  } catch (error) {
    if (error instanceof CancelledError) {
      console.error("Dibatalkan.");
      process.exit(1);
    }

    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

class CancelledError extends Error {}

function ensureRoot() {
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    fatal("winmu harus dijalankan sebagai root.");
  }
}

function initializeLayout() {
  for (const dir of [BASE_DIR, OS_DIR, VIRTIO_DIR, MANIFEST_DIR, CONTAINERS_DIR, TMP_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  }
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function runInteractiveMenu() {
  ensureWhiptail();
  while (true) {
    const choice = menu("Winmu", "Pilih aksi:", [
      ["setup", "Setup qemu"],
      ["download-os", "Download OS"],
      ["download-virtio", "Download driver virtio"],
      ["create", "Create Container"],
      ["delete", "Delete Container"],
      ["exit", "Keluar"]
    ]);

    switch (choice) {
      case "setup":
        setupQemu({ interactive: true });
        break;
      case "download-os":
        downloadOs({ interactive: true });
        break;
      case "download-virtio":
        downloadVirtio({ interactive: true });
        break;
      case "create":
        createContainer({ interactive: true });
        break;
      case "delete":
        deleteContainer({ interactive: true });
        break;
      case "exit":
      case null:
        return;
      default:
        return;
    }
  }
}

function setupQemu(options = {}) {
  const interactive = !!options.interactive;
  if (interactive && !yesno("Setup qemu", "Install paket QEMU sekarang?")) {
    return;
  }

  runCommand("apt-get", ["update"]);
  runCommand("apt-get", ["install", "-y", "qemu"]);
  runCommand("apt-get", ["install", "-y", "qemu-utils"]);
  runCommand("apt-get", ["install", "-y", "qemu-system-x86-xen"]);
  runCommand("apt-get", ["install", "-y", "qemu-system-x86"]);
  runCommand("apt-get", ["install", "-y", "qemu-kvm"]);
  runCommand("apt-get", ["install", "-y", "whiptail", "curl", "zstd"]);

  notify(interactive, "Setup qemu", "Instalasi QEMU selesai.");
}

function downloadOs(options = {}) {
  const interactive = !!options.interactive;
  const config = loadConfig();
  const manifestPath = path.join(MANIFEST_DIR, config.os.manifestName);
  const manifestUrl = buildReleaseAssetUrl(config, config.os.manifestName);

  downloadFile(manifestUrl, manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  const archiveTmp = path.join(TMP_DIR, manifest.archive.name);
  const partsDir = path.join(TMP_DIR, "os-parts");
  fs.rmSync(partsDir, { recursive: true, force: true });
  fs.mkdirSync(partsDir, { recursive: true });

  for (const part of manifest.archive.parts) {
    const partPath = path.join(partsDir, part.name);
    downloadFile(buildReleaseAssetUrl(config, part.name), partPath);
    verifySha256(partPath, part.sha256);
  }

  concatFiles(
    manifest.archive.parts.map((part) => path.join(partsDir, part.name)),
    archiveTmp
  );

  verifySha256(archiveTmp, manifest.archive.sha256);

  fs.rmSync(path.join(OS_DIR, manifest.files.iso.name), { force: true });
  fs.rmSync(path.join(OS_DIR, manifest.files.img.name), { force: true });

  runCommand("tar", ["--zstd", "-xf", archiveTmp, "-C", OS_DIR]);

  verifySha256(path.join(OS_DIR, manifest.files.iso.name), manifest.files.iso.sha256);
  verifySha256(path.join(OS_DIR, manifest.files.img.name), manifest.files.img.sha256);

  fs.rmSync(partsDir, { recursive: true, force: true });
  fs.rmSync(archiveTmp, { force: true });

  notify(
    interactive,
    "Download OS",
    `OS siap di ${OS_DIR}\nISO: ${manifest.files.iso.name}\nIMG: ${manifest.files.img.name}`
  );
}

function downloadVirtio(options = {}) {
  const interactive = !!options.interactive;
  const config = loadConfig();
  const manifestPath = path.join(MANIFEST_DIR, config.virtio.manifestName);
  const manifestUrl = buildReleaseAssetUrl(config, config.virtio.manifestName);

  downloadFile(manifestUrl, manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const assetPath = path.join(VIRTIO_DIR, manifest.asset.name);

  downloadFile(buildReleaseAssetUrl(config, manifest.asset.name), assetPath);
  verifySha256(assetPath, manifest.asset.sha256);

  if (manifest.asset.name !== config.virtio.targetName) {
    fs.copyFileSync(assetPath, path.join(VIRTIO_DIR, config.virtio.targetName));
  }

  notify(interactive, "Download Virtio", `Driver virtio siap di ${VIRTIO_DIR}`);
}

function createContainer(options = {}) {
  const interactive = !!options.interactive;
  ensureQemuInstalled();
  const config = loadConfig();
  const osImagePath = path.join(OS_DIR, config.os.extractedImgName);

  if (!fs.existsSync(osImagePath)) {
    notify(interactive, "Create Container", `OS image belum ada di ${OS_DIR}. Jalankan Download OS terlebih dahulu.`);
    return;
  }

  const requestedProfile = options.profile || options.p;
  const profileKey = requestedProfile || (interactive
    ? menu("Create Container", "Pilih profil VM:", [
        ["small", describeProfile("small")],
        ["medium", describeProfile("medium")],
        ["large", describeProfile("large")]
      ])
    : "small");

  if (!profileKey) {
    return;
  }
  if (!VM_PROFILES[profileKey]) {
    fatal(`Profile tidak dikenal: ${profileKey}`);
  }

  const profile = VM_PROFILES[profileKey];
  const specs = detectHostSpecs();
  const allocations = readContainerAllocations();
  const recommendation = calculateCapacity(specs, allocations, profile);

  const summary = [
    `CPU total      : ${specs.cpuThreads}`,
    `RAM total      : ${toHumanGb(specs.ramMb)} GB (${specs.ramMb} MB)`,
    `Disk total     : ${specs.diskGb} GB`,
    "",
    `CPU host       : ${specs.reserveCpu}`,
    `RAM host       : ${toHumanGb(specs.reserveRamMb)} GB (${specs.reserveRamMb} MB)`,
    `Disk host      : ${specs.reserveDiskGb} GB`,
    "",
    `CPU terpakai   : ${allocations.cpu}`,
    `RAM terpakai   : ${toHumanGb(allocations.ramMb)} GB (${allocations.ramMb} MB)`,
    `Disk terpakai  : ${allocations.diskGb} GB`,
    "",
    `Tambahan aman  : ${recommendation.maxAdditional} VM profile ${profileKey}`,
    `VNC berikutnya : :${findNextVncDisplay()}`
  ].join("\n");

  if (interactive) {
    msgbox("Kapasitas VPS", summary);
  } else {
    console.log(summary);
  }

  if (recommendation.maxAdditional <= 0) {
    notify(interactive, "Create Container", `Resource VPS tidak cukup untuk profile ${profileKey}.`);
    return;
  }

  const providedName = sanitizeName(options.name || options.n || "");
  const vmName = providedName || (interactive
    ? sanitizeName(inputbox("Create Container", "Masukkan nama container/vm:", `win10-${profileKey}-1`) || "")
    : `win10-${profileKey}-1`);

  if (!vmName) {
    return;
  }

  const vmDir = path.join(HOME_DIR, vmName);
  if (fs.existsSync(vmDir)) {
    notify(interactive, "Create Container", `Folder VM sudah ada: ${vmDir}`);
    return;
  }

  const vncDisplay = findNextVncDisplay();
  const kvmEnabled = fs.existsSync("/dev/kvm");
  const systemdServiceName = `winmu-${vmName}.service`;
  const overlayPath = path.join(vmDir, "disk.qcow2");
  const metadataPath = path.join(CONTAINERS_DIR, `${vmName}.json`);

  fs.mkdirSync(vmDir, { recursive: true });
  runCommand("qemu-img", [
    "create",
    "-f",
    "qcow2",
    "-F",
    "raw",
    "-b",
    osImagePath,
    overlayPath
  ]);

  const serviceText = renderService({
    vmName,
    vmDir,
    overlayPath,
    profile,
    vncDisplay,
    kvmEnabled
  });

  fs.writeFileSync(path.join(vmDir, "qemu.service"), serviceText);
  fs.writeFileSync(path.join(SYSTEMD_DIR, systemdServiceName), serviceText);

  const metadata = {
    vmName,
    profile: profileKey,
    cpu: profile.cpu,
    ramMb: profile.ramMb,
    diskGb: profile.diskGb,
    vncDisplay,
    service: systemdServiceName,
    vmDir,
    overlayPath,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

  runCommand("systemctl", ["daemon-reload"]);
  runCommand("systemctl", ["enable", "--now", systemdServiceName]);

  notify(
    interactive,
    "Create Container",
    [
      `VM berhasil dibuat: ${vmName}`,
      `Folder       : ${vmDir}`,
      `Service      : ${systemdServiceName}`,
      `VNC          : :${vncDisplay} (port ${5900 + vncDisplay})`,
      `Overlay disk : ${overlayPath}`
    ].join("\n")
  );
}

function deleteContainer(options = {}) {
  const interactive = !!options.interactive;
  const containers = listContainers();
  if (containers.length === 0) {
    notify(interactive, "Delete Container", "Belum ada VM yang dibuat oleh winmu.");
    return;
  }

  const requestedName = options.name || options.n;
  const choice = requestedName || (interactive
    ? menu(
        "Delete Container",
        "Pilih VM yang akan dihapus:",
        containers.map((container) => [
          container.vmName,
          `${container.profile} | VNC :${container.vncDisplay} | ${container.vmDir}`
        ])
      )
    : containers[0].vmName);

  if (!choice) {
    return;
  }

  const container = containers.find((item) => item.vmName === choice);
  if (!container) {
    fatal(`VM tidak ditemukan: ${choice}`);
  }

  if (interactive && !yesno("Delete Container", `Hapus VM ${container.vmName}?`)) {
    return;
  }

  runCommand("systemctl", ["disable", "--now", container.service], { allowFailure: true });
  fs.rmSync(path.join(SYSTEMD_DIR, container.service), { force: true });
  fs.rmSync(container.vmDir, { recursive: true, force: true });
  fs.rmSync(path.join(CONTAINERS_DIR, `${container.vmName}.json`), { force: true });
  runCommand("systemctl", ["daemon-reload"]);

  notify(interactive, "Delete Container", `VM ${container.vmName} berhasil dihapus.`);
}

function packOsAssets(args) {
  const config = loadConfig();
  const isoPath = path.resolve(args.iso || "/root/windows10.iso");
  const imgPath = path.resolve(args.img || "/root/windows10.img");
  const virtioPath = path.resolve(args.virtio || "/root/virtio-win.iso");
  const tag = args.tag || config.github.releaseTag;
  const partSize = args["part-size"] || config.packaging.partSize;
  const outputDir = path.resolve(args.output || path.join(HOME_DIR, "windows10-qemu", "dist", "assets", tag));

  for (const requiredPath of [isoPath, imgPath, virtioPath]) {
    if (!fs.existsSync(requiredPath)) {
      fatal(`File tidak ditemukan: ${requiredPath}`);
    }
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const archiveName = config.os.archiveName;
  const archivePath = path.join(outputDir, archiveName);
  const splitPrefix = `${archiveName}.part-`;
  const partPrefixPath = path.join(outputDir, splitPrefix);
  const virtioOutputPath = path.join(outputDir, path.basename(virtioPath));

  runCommand("tar", ["--zstd", "-cf", archivePath, "-C", path.dirname(isoPath), path.basename(isoPath), "-C", path.dirname(imgPath), path.basename(imgPath)]);
  runCommand("split", ["-b", partSize, "-d", "-a", "3", archivePath, partPrefixPath]);
  fs.copyFileSync(virtioPath, virtioOutputPath);

  const partFiles = fs
    .readdirSync(outputDir)
    .filter((name) => name.startsWith(splitPrefix))
    .sort();

  const osManifest = {
    releaseTag: tag,
    archive: {
      name: archiveName,
      sha256: computeSha256(archivePath),
      parts: partFiles.map((name) => ({
        name,
        sha256: computeSha256(path.join(outputDir, name))
      }))
    },
    files: {
      iso: {
        name: path.basename(isoPath),
        sha256: computeSha256(isoPath),
        size: fs.statSync(isoPath).size
      },
      img: {
        name: path.basename(imgPath),
        sha256: computeSha256(imgPath),
        size: fs.statSync(imgPath).size
      }
    }
  };

  const virtioManifest = {
    releaseTag: tag,
    asset: {
      name: path.basename(virtioOutputPath),
      sha256: computeSha256(virtioOutputPath),
      size: fs.statSync(virtioOutputPath).size
    }
  };

  fs.writeFileSync(path.join(outputDir, config.os.manifestName), `${JSON.stringify(osManifest, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, config.virtio.manifestName), `${JSON.stringify(virtioManifest, null, 2)}\n`);
  fs.rmSync(archivePath, { force: true });

  console.log(`Asset OS dan virtio sudah disiapkan di ${outputDir}`);
  console.log(`Part size: ${partSize}`);
  console.log(`Upload semua file di folder ini ke GitHub Release tag '${tag}'.`);
}

function ensureWhiptail() {
  if (!commandExists("whiptail")) {
    fatal("whiptail belum tersedia. Install paket whiptail terlebih dahulu.");
  }
}

function ensureQemuInstalled() {
  for (const command of ["qemu-system-x86_64", "qemu-img", "systemctl"]) {
    if (!commandExists(command)) {
      fatal(`${command} tidak ditemukan. Jalankan Setup qemu terlebih dahulu.`);
    }
  }
}

function detectHostSpecs() {
  const ramKb = readFirstMatch("/proc/meminfo", /^MemTotal:\s+(\d+)/m);
  const ramMb = Math.floor(Number(ramKb) / 1024);
  const cpuThreads = Number(runCommandCapture("nproc", []).trim());
  const diskGb = Number(runCommandCapture("df", ["-BG", "/"]).trim().split("\n")[1].split(/\s+/)[1].replace("G", ""));

  let reserveRamMb = Math.floor(ramMb / 5);
  if (reserveRamMb < 1024) {
    reserveRamMb = 1024;
  }

  let reserveCpu = 1;
  if (cpuThreads <= 1) {
    reserveCpu = 0;
  }

  let reserveDiskGb = 20;
  if (diskGb <= 40) {
    reserveDiskGb = 10;
  }

  return {
    ramMb,
    cpuThreads,
    diskGb,
    reserveRamMb,
    reserveCpu,
    reserveDiskGb
  };
}

function calculateCapacity(specs, allocations, profile) {
  const usableRamMb = Math.max(0, specs.ramMb - specs.reserveRamMb - allocations.ramMb);
  const usableCpu = Math.max(0, specs.cpuThreads - specs.reserveCpu - allocations.cpu);
  const usableDiskGb = Math.max(0, specs.diskGb - specs.reserveDiskGb - allocations.diskGb);

  const byRam = Math.floor(usableRamMb / profile.ramMb);
  const byCpu = Math.floor(usableCpu / profile.cpu);
  const byDisk = Math.floor(usableDiskGb / profile.diskGb);

  return {
    usableRamMb,
    usableCpu,
    usableDiskGb,
    maxAdditional: Math.max(0, Math.min(byRam, byCpu, byDisk))
  };
}

function readContainerAllocations() {
  const containers = listContainers();
  return containers.reduce(
    (acc, item) => {
      acc.cpu += item.cpu;
      acc.ramMb += item.ramMb;
      acc.diskGb += item.diskGb;
      return acc;
    },
    { cpu: 0, ramMb: 0, diskGb: 0 }
  );
}

function listContainers() {
  if (!fs.existsSync(CONTAINERS_DIR)) {
    return [];
  }

  return fs
    .readdirSync(CONTAINERS_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(CONTAINERS_DIR, name), "utf8")))
    .sort((left, right) => left.vmName.localeCompare(right.vmName));
}

function findNextVncDisplay() {
  const used = new Set(listContainers().map((container) => Number(container.vncDisplay)));
  let candidate = 1;
  while (used.has(candidate)) {
    candidate += 1;
  }
  return candidate;
}

function renderService({ vmName, vmDir, overlayPath, profile, vncDisplay, kvmEnabled }) {
  const cpuModel = kvmEnabled ? "host" : "max";
  const args = [
    "/usr/bin/qemu-system-x86_64",
    `-name ${escapeSystemdArg(vmName)}`,
    "-machine q35",
    `-m ${profile.ramMb}`,
    `-smp ${profile.cpu}`,
    `-cpu ${cpuModel}`,
    "-boot order=c",
    `-drive file=${escapeSystemdArg(overlayPath)},format=qcow2,if=virtio`,
    "-netdev user,id=net0",
    "-device virtio-net-pci,netdev=net0",
    "-display none",
    `-vnc 0.0.0.0:${vncDisplay}`,
    "-monitor none",
    "-serial none"
  ];

  if (kvmEnabled) {
    args.splice(5, 0, "-enable-kvm");
  }

  return [
    "[Unit]",
    `Description=winmu VM ${vmName}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${vmDir}`,
    `ExecStart=${args.join(" ")}`,
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    ""
  ].join("\n");
}

function buildReleaseAssetUrl(config, assetName) {
  const { owner, repo, releaseTag } = config.github;
  if (releaseTag === "latest") {
    return `https://github.com/${owner}/${repo}/releases/latest/download/${assetName}`;
  }

  return `https://github.com/${owner}/${repo}/releases/download/${releaseTag}/${assetName}`;
}

function menu(title, prompt, items) {
  ensureWhiptail();
  const args = ["--title", title, "--menu", prompt, "20", "90", String(items.length)];
  for (const [tag, description] of items) {
    args.push(tag, description);
  }

  const result = spawnSync("whiptail", args, { encoding: "utf8" });
  if (result.status === 255 || result.status === 1) {
    return null;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Gagal menampilkan menu.");
  }
  return (result.stderr || "").trim();
}

function inputbox(title, prompt, defaultValue = "") {
  ensureWhiptail();
  const result = spawnSync(
    "whiptail",
    ["--title", title, "--inputbox", prompt, "10", "80", defaultValue],
    { encoding: "utf8" }
  );

  if (result.status === 255 || result.status === 1) {
    return null;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Gagal membaca input.");
  }
  return (result.stderr || "").trim();
}

function yesno(title, prompt) {
  ensureWhiptail();
  const result = spawnSync("whiptail", ["--title", title, "--yesno", prompt, "10", "80"], { encoding: "utf8" });
  if (result.status === 255 || result.status === 1) {
    return false;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Gagal membaca konfirmasi.");
  }
  return true;
}

function msgbox(title, message) {
  ensureWhiptail();
  const result = spawnSync("whiptail", ["--title", title, "--msgbox", message, "20", "90"], { encoding: "utf8" });
  if (result.status !== 0 && result.status !== 255) {
    throw new Error(result.stderr.trim() || "Gagal menampilkan pesan.");
  }
}

function notify(interactive, title, message) {
  if (interactive) {
    msgbox(title, message);
  } else {
    console.log(message);
  }
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} gagal dengan exit code ${result.status}`);
  }
  return result;
}

function runCommandCapture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} gagal dengan exit code ${result.status}`);
  }
  return result.stdout;
}

function downloadFile(url, targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  runCommand("curl", ["-L", "--fail", "--retry", "5", "--retry-delay", "3", "-o", targetPath, url]);
}

function verifySha256(filePath, expected) {
  const actual = computeSha256(filePath);
  if (actual !== expected) {
    throw new Error(`Checksum mismatch untuk ${filePath}\nExpected: ${expected}\nActual:   ${actual}`);
  }
}

function computeSha256(filePath) {
  return runCommandCapture("sha256sum", [filePath]).trim().split(/\s+/)[0];
}

function concatFiles(parts, target) {
  const script = `${parts.map((part) => shellEscape(part)).join(" ")} > ${shellEscape(target)}`;
  runCommand("bash", ["-lc", `cat ${script}`]);
}

function commandExists(command) {
  const result = spawnSync("bash", ["-lc", `command -v ${shellEscape(command)}`], { stdio: "ignore" });
  return result.status === 0;
}

function describeProfile(profileKey) {
  const profile = VM_PROFILES[profileKey];
  return `${profile.label} | ${profile.cpu} CPU | ${toHumanGb(profile.ramMb)} GB RAM | ${profile.diskGb} GB disk`;
}

function sanitizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function readFirstMatch(filePath, pattern) {
  const content = fs.readFileSync(filePath, "utf8");
  const match = content.match(pattern);
  if (!match) {
    throw new Error(`Tidak dapat membaca ${filePath}`);
  }
  return match[1];
}

function toHumanGb(mb) {
  return (mb / 1024).toFixed(1);
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item.startsWith("--")) {
      continue;
    }
    const key = item.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function fatal(message) {
  throw new Error(message);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function escapeSystemdArg(value) {
  return String(value).replace(/(["\\\s'$`])/g, "\\$1");
}

main();
