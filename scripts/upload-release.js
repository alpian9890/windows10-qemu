#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");

const owner = process.env.GITHUB_OWNER || "alpian9890";
const repo = process.env.GITHUB_REPO || "windows10-qemu";
const tag = process.env.GITHUB_RELEASE_TAG || "assets";
const assetDir = process.env.WINMU_ASSET_DIR || "/root/windows10-qemu/dist/assets/assets";

function getCredentials() {
  const output = execSync(
    'printf "protocol=https\\nhost=github.com\\n\\n" | git credential fill',
    { encoding: "utf8" }
  );

  const entries = Object.fromEntries(
    output
      .trim()
      .split("\n")
      .map((line) => line.split(/=(.*)/s).slice(0, 2))
  );

  if (!entries.username || !entries.password) {
    throw new Error("GitHub credentials not found via git credential helper.");
  }

  return entries;
}

function authHeaders(extraHeaders = {}) {
  const { username, password } = getCredentials();
  return {
    "User-Agent": "winmu-release-uploader",
    Accept: "application/vnd.github+json",
    Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
    ...extraHeaders
  };
}

function requestJson({ method, host, pathname, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        method,
        host,
        path: pathname,
        headers: authHeaders(headers)
      },
      (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          const ok = response.statusCode >= 200 && response.statusCode < 300;
          if (!ok) {
            reject(
              new Error(
                `GitHub API ${method} ${pathname} failed: ${response.statusCode} ${data}`
              )
            );
            return;
          }

          resolve({
            headers: response.headers,
            body: data ? JSON.parse(data) : null
          });
        });
      }
    );

    request.on("error", reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

function uploadAsset(uploadUrl, filePath) {
  const fileName = path.basename(filePath);
  const stats = fs.statSync(filePath);
  const url = new URL(uploadUrl.replace("{?name,label}", `?name=${encodeURIComponent(fileName)}`));

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        method: "POST",
        host: url.host,
        path: `${url.pathname}${url.search}`,
        headers: authHeaders({
          "Content-Type": "application/octet-stream",
          "Content-Length": stats.size
        })
      },
      (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          const ok = response.statusCode >= 200 && response.statusCode < 300;
          if (!ok) {
            reject(new Error(`Upload ${fileName} failed: ${response.statusCode} ${data}`));
            return;
          }

          resolve(JSON.parse(data));
        });
      }
    );

    request.on("error", reject);

    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.pipe(request);
  });
}

async function ensureRelease() {
  try {
    const response = await requestJson({
      method: "GET",
      host: "api.github.com",
      pathname: `/repos/${owner}/${repo}/releases/tags/${tag}`
    });
    console.log(`Release '${tag}' already exists.`);
    return response.body;
  } catch (error) {
    if (!String(error.message).includes("404")) {
      throw error;
    }

    const response = await requestJson({
      method: "POST",
      host: "api.github.com",
      pathname: `/repos/${owner}/${repo}/releases`,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        tag_name: tag,
        name: tag,
        draft: false,
        prerelease: false
      })
    });

    console.log(`Release '${tag}' created.`);
    return response.body;
  }
}

async function deleteDuplicateAssets(releaseId, assetNames) {
  const response = await requestJson({
    method: "GET",
    host: "api.github.com",
    pathname: `/repos/${owner}/${repo}/releases/${releaseId}/assets`
  });

  for (const asset of response.body) {
    if (!assetNames.includes(asset.name)) {
      continue;
    }

    await requestJson({
      method: "DELETE",
      host: "api.github.com",
      pathname: `/repos/${owner}/${repo}/releases/assets/${asset.id}`
    });
    console.log(`Deleted existing asset ${asset.name}`);
  }
}

async function main() {
  if (!fs.existsSync(assetDir)) {
    throw new Error(`Asset directory not found: ${assetDir}`);
  }

  const assetFiles = fs
    .readdirSync(assetDir)
    .filter((name) => fs.statSync(path.join(assetDir, name)).isFile())
    .sort();

  if (assetFiles.length === 0) {
    throw new Error(`No release assets found in ${assetDir}`);
  }

  const release = await ensureRelease();
  await deleteDuplicateAssets(release.id, assetFiles);

  for (const fileName of assetFiles) {
    const fullPath = path.join(assetDir, fileName);
    const sizeMiB = Math.ceil(fs.statSync(fullPath).size / 1024 / 1024);
    console.log(`Uploading ${fileName} (${sizeMiB} MiB)...`);
    await uploadAsset(release.upload_url, fullPath);
    console.log(`Uploaded ${fileName}`);
  }

  console.log(`Release upload complete: https://github.com/${owner}/${repo}/releases/tag/${tag}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
