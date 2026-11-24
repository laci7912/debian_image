# Debian 12 webterm – GitHub változat (lite)

Ez a **kis méretű** változat: a teljes `debian_hda.img`-ból csak azokat a
darabokat tartalmazza, amelyeket a tanórákon használt parancsok tényleg
olvasnak. Ugyanaz a valódi Debian 12 rendszer indul el, ugyanazzal a kernellel
és ext4 fájlrendszerrel — csak a ritkán használt fájlok maradnak ki.

- **Méret:** 91,7 MiB (479 gzip-elt darab) — a teljes változat 336,9 MiB
- **Első indítás:** ~6,8 MiB letöltés, ~30 másodperc
- **Ellenőrzött:** 62 parancs valódi HTTP-n, **0 hiba**, két különböző
  parancssorrendben is

A teljes változat: [`github-version`](../github-version).

> **Kiosztás tanulóknak:** a részletes útmutató (ábrákkal, public/privát
> magyarázattal) itt van: [`HOGYAN-MUKODIK.md`](../HOGYAN-MUKODIK.md).
> Egy parancs, és kapsz egyetlen HTML fájlt, amit a tanuló dupla kattintással
> megnyit:
>
> ```bat
> node tools\make-student-file.js . https://FELHASZNALO.github.io/REPO/
> ```

---

## Mit tud?

A mérés **~250 parancsot** futtatott végig egy valódi vendégrendszeren, és
ezek mind működtek. A fontosabbak:

| Terület | Parancsok |
|---|---|
| Alap | `ls`, `cd`, `pwd`, `cat`, `echo`, `date`, `whoami`, `id` |
| Szöveg | `head`, `tail`, `wc`, `grep`, `sort`, `uniq`, `cut`, `sed`, `awk`, `tr`, `nl` |
| Fájlok | `find`, `stat`, `file`, `md5sum`, `du`, `df`, `ln`, `chmod`, `chown`, `umask` |
| Rendszer | `uname`, `hostname`, `ps`, `mount`, `free`, `uptime`, `dmesg`, `lsblk`, `vmstat` |
| Csomagok | `dpkg -l`, `dpkg -L`, `dpkg -S`, `dpkg -s`, `apt list`, `apt-cache policy/show` |
| Kézikönyv | `man`, `man -k`, `whatis`, `apropos`, `info` |
| Archívum | `tar`, `gzip`, `bzip2`, `xz`, `zip`, `unzip` |
| Szerkesztő | `vim`, `nano`, `ed` |
| Felhasználók | `useradd --help`, `passwd --help`, `chage -l`, `last`, `who`, `w` |
| Egyéb | `perl`, `python3`, `bc`, `gcc --version`, `lsmod`, `lsof`, `blkid` |

## Mi hiányzik?

A 479 darab a lemezkép 1536 darabjának kb. **31%-a**. A kimaradt részek
nagyrészt olyan fájlok, amelyeket egy tanóra nem olvas, például:

- nagy licencszövegek (`/usr/share/common-licenses/*`)
- egyes SSL- és dokumentációs adatfájlok
- ritkán használt programok és könyvtárak darabjai

Ilyenkor a vendég **nulla bájtokat** olvas a hiányzó helyről, ezért a kimenet
hibás lehet (`Exec format error`, üres kimenet). A felület ezt jelzi:

> `[hiányzó lemeztömb – a kisebb (lite) változat nem tartalmazza ezt a fájlt]`

Ha valamire mégis szükség van, használd a **teljes** változatot — ott nincs
ilyen korlát.

---

## Feltöltés GitHubra

```bat
cd github-version-lite
git init
git add .
git commit -m "Debian 12 webterm (lite)"
git branch -M main
git remote add origin https://github.com/<felhasznalo>/<repo>.git
git push -u origin main
```

Majd a repó **Settings → Pages** menüjében: `main` ág, `/ (root)` mappa.

```
https://<felhasznalo>.github.io/<repo>/index.html
```

A 91,7 MiB-os méret miatt ez a változat kényelmesen feltölthető, és a GitHub
Pages is gyorsan kiszolgálja.

---

## Helyi kipróbálás

A `file://` **nem működik** (a böngésző nem engedi a `fetch`-et), ezért kell
egy helyi HTTP-szerver. Ez a mappa **önálló**: a saját `tools/serve.js` fájlja
pontosan ezt a mappát szolgálja ki, ahogy a GitHub Pages is teszi.

A legegyszerűbb: kattints a **`start.bat`** fájlra.

Kézzel ugyanez:

```bat
node tools\serve.js 8097
```

majd: <http://localhost:8097/index.html>

Ha a `webterm` mappából indítod, az is működik:

```bat
node ..\webterm\tools\serve.js 8080
```

majd: <http://localhost:8080/github-version-lite/index.html>

---

## Hogyan készült a darablista?

Ez a rész technikailag fontos, mert egy naiv mérés **hibás** készletet ad.

A `disk/manifest.json` tartalmazza a létező darabok listáját (`present`). A
`js/lazydisk.js` ebből tudja, hogy egy adott darabot érdemes-e egyáltalán
letölteni.

A lista a `measure-union.js` mérésből származik. Az első próbálkozás csak
azokat a darabokat jegyezte fel, amelyeket a vendég **éppen akkor** kért le.
Ez viszont függ a parancsok sorrendjétől: a vendég kernel gyorsítótárazza a
blokkokat, ezért egy későbbi parancs már nem olvassa a lemezt arról, amit egy
korábbi betöltött.

Emiatt esett ki a `/usr/bin/find` egy darabja (660. chunk): a mérés során
mindig volt már a gyorsítótárban, önállóan viszont `Exec format error` lett.

A helyes módszer a **shadow-szolgálás**: a mérés a jelenlegi készlettel indul,
és minden olyan darabot, ami hiányzik a készletből, de nem csupa nulla a
képben, feljegyez **és** kiszolgál, hogy a parancs mégis lefusson. Több
kevert sorrendű menet uniója után a készlet sorrendfüggetlen lesz.

Ezért lett a készlet 201 helyett 479 darab — a nagyobb méret itt a
**helyesség** ára, nem pazarlás.

Újraépítés (a mérés a jelenlegi készletből indul, és csak a hiányzókat
keresi hozzá):

```bat
node tools\measure-union.js disk\manifest.json uj-lista.json 2 ..\debian_hda.img
node tools\build-lite.js uj-lista.json ..\debian_hda.img disk
```

Az első parancs két kevert sorrendű menetet futtat végig egy valódi
vendégrendszeren, és a `disk/manifest.json` `present` listáját használja
kiindulásnak. A második a bővített listából állítja elő a darabokat.

Ha a készlet teljes, a mérés ezt írja: `added : 0`.

---

## Fájlok

```
index.html                 a webes felület (magyar)
js/lazydisk.js             darabokat lustán letöltő v86 lemezobjektum
boot/bzimage               Debian kernel (6.1.0-50-686)
boot/initramfs.gz          saját initramfs (busybox + ext4 tároló modulok)
v86/                       v86 emulátor
vendor/                    xterm.js terminál
disk/                      479 gzip-elt darab + manifest.json
tools/make-disk-chunks.js  a darabok előállítása
tools/build-lite.js        lite készlet építése mérésből
tools/cdp-check.js         6 parancsos füstteszt
tools/serve.js             helyi HTTP-szerver (ezt a mappát szolgálja ki)
start.bat                  helyi indítás Windowson
```

---

## Korlátok

- A vendég **read-only** gyökérrel fut; a `/tmp`, `/root`, `/var/log` tmpfs,
  ezért újraindításkor minden módosítás elvész.
- **Nincs hálózat**: `apt update`, `ping`, `curl` nem használható.
- **32 bites**, egyprocesszoros, 512 MB memóriás vendég.
- Az első indítás ~30 másodperc.
- Böngészőben `DecompressionStream` kell (Chrome/Edge 80+, Firefox 113+).
