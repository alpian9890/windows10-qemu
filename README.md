# winmu

`winmu` adalah CLI/TUI single binary untuk mengelola Windows on QEMU di VPS Linux.

Fitur utama:

- Setup paket QEMU
- Download OS Windows dari GitHub Releases lalu ekstrak ke `/etc/winmu/os`
- Download driver virtio ke `/etc/winmu/virtio`
- Create/List/Delete VM QEMU yang disimpan di `~/<nama-vm>`
- Menjalankan VM sebagai service `systemd`
- Menyiapkan split archive asset OS untuk GitHub Releases

## Build

```bash
npm install
npm run build
```

## Install binary

Install langsung dari GitHub Release tanpa build dari source.

```bash
curl -fsSL https://github.com/alpian9890/windows10-qemu/releases/download/assets/install-winmu.sh | bash
```

Atau dengan `wget`:

```bash
wget -qO- https://github.com/alpian9890/windows10-qemu/releases/download/assets/install-winmu.sh | bash
```

## Jalankan

```bash
winmu
```

## Login Windows

Default login Windows 10 Pro:

```text
Username: Admin
Password: Admin
```

Catatan recovery question:

- Untuk semua pertanyaan recovery, isi `Admin`

## Utility untuk maintainer

Membuat split archive asset release dari file yang sudah ada di server:

```bash
winmu pack-os-assets \
  --iso /root/windows10.iso \
  --img /root/windows10.img \
  --virtio /root/virtio-win.iso \
  --tag assets \
  --part-size 1900M
```
