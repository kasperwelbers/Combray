"""Generates the researcher key explainer, keys.html (English only; participants read the in-app FAQ)."""
import sys, re
import os

# Writes keys.html next to this script. An optional path also gets the fragment that is published
# as a shareable page (no doctype, Google Fonts allowed there).
out_repo = os.path.join(os.path.dirname(os.path.abspath(__file__)), "keys.html")
out_fragment = sys.argv[1] if len(sys.argv) > 1 else None

C = {"gold": "var(--madeleine)", "dusk": "var(--dusk)", "green": "var(--tilleul)", "terra": "var(--terracotta)"}

def use(sym, x, y, w, h, color=None, extra=""):
    st = f' style="color:{C[color]}"' if color else ""
    return f'<use href="#{sym}" x="{x}" y="{y}" width="{w}" height="{h}"{st} {extra}/>'

def browser(x, y, w, h):
    return (f'<g class="frame"><rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10"/>'
            f'<line x1="{x}" y1="{y+18}" x2="{x+w}" y2="{y+18}"/>'
            + "".join(f'<circle cx="{x+12+i*9}" cy="{y+9}" r="2.5"/>' for i in range(3)) + "</g>")

def label(x, y, text, anchor="start", cls="lbl"):
    return f'<text class="{cls}" x="{x}" y="{y}" text-anchor="{anchor}">{text}</text>'

def arrow(d, dashed=False):
    cls = "arrow dashed" if dashed else "arrow"
    return f'<path class="{cls}" d="{d}" marker-end="url(#ah)"/>'

def line(d):
    return f'<path class="arrow dashed" d="{d}"/>'

def hall(x, y, s=96):
    return use("hall", x, y, s, s) + label(x + s / 2, y - 10, "Server", "middle")

def scene(title, body):
    return f'<svg class="scene" viewBox="0 0 400 214" role="img"><title>{title}</title>{body}</svg>'

COMPUTER = "Your computer"

S1 = scene("Your data is locked with the data key; the data key goes into a box whose key the server keeps",
    browser(6, 22, 250, 186) + label(10, 15, COMPUTER)
    + use("cards", 22, 54, 70, 56) + arrow("M98 82 H128") + use("locked", 134, 54, 70, 56, "gold")
    + label(57, 128, "your data", "middle", "cap") + label(169, 128, "locked", "middle", "cap")
    + use("key", 28, 150, 56, 24, "gold") + arrow("M90 162 H128") + use("box", 134, 140, 60, 52)
    + label(56, 192, "data key", "middle", "cap")
    + hall(292, 44) + use("key", 308, 156, 64, 28, "dusk")
    + line("M200 168 C240 176, 270 176, 302 170")
    + label(340, 202, "key to the box", "middle", "cap"))

S3 = scene("When you stop, the browser throws away the keys and the readable data; locked data and a closed box remain",
    browser(6, 22, 250, 186) + label(10, 15, COMPUTER)
    + use("locked", 22, 50, 70, 56, "gold") + use("box", 28, 130, 60, 52)
    + label(57, 202, "this stays", "middle", "cap")
    + use("clock", 112, 48, 30, 30) + label(127, 92, "15 min", "middle", "cap")
    + f'<g class="gone">{use("cards", 112, 110, 54, 43)}{use("key", 166, 68, 50, 21, "gold")}</g>'
    + arrow("M150 156 L186 168") + arrow("M200 94 L204 140") + use("bin", 184, 142, 44, 50)
    + hall(292, 44) + use("key", 308, 156, 64, 28, "dusk")
    + label(340, 202, "stays at the server", "middle", "cap"))

S4 = scene("You choose what to share; it is locked with a new donation key, which goes into the researcher's box; the server keeps both apart",
    browser(6, 22, 250, 186) + label(10, 15, COMPUTER)
    + use("cards", 18, 52, 70, 56) + arrow("M94 80 H124") + use("locked", 130, 58, 58, 46, "green")
    + label(53, 126, "you choose", "middle", "cap") + label(159, 122, "donation", "middle", "cap")
    + use("key", 24, 150, 54, 23, "green") + arrow("M84 162 H112") + use("letterbox", 118, 138, 60, 52, "terra")
    + label(51, 192, "donation key", "middle", "cap")
    + hall(292, 44)
    + arrow("M192 66 C250 20, 372 20, 368 142") + arrow("M182 170 C230 196, 270 190, 294 176")
    + use("letterbox", 296, 150, 44, 38, "terra") + use("locked", 346, 150, 44, 36, "green")
    + label(343, 206, "kept apart", "middle", "cap"))

S5 = scene("Each time, the researcher fetches the box from the server, opens it with the project key, reads, and throws the donation key away",
    hall(16, 44) + use("letterbox", 20, 150, 44, 38, "terra") + use("locked", 68, 150, 44, 36, "green")
    + arrow("M66 160 C130 120, 180 110, 238 104")
    + label(150, 100, "every time", "middle", "cap")
    + use("laptop", 238, 46, 132, 102) + label(304, 36, "Researcher", "middle")
    + use("cards", 262, 58, 48, 38) + use("key", 318, 78, 40, 17, "green")
    + use("key", 160, 44, 52, 22, "terra") + arrow("M214 56 C226 58, 236 64, 244 74")
    + label(186, 36, "project key", "middle", "cap")
    + use("locked", 246, 162, 44, 36, "green") + label(268, 210, "stays locked", "middle", "cap")
    + arrow("M346 102 L354 150") + use("bin", 338, 152, 38, 44))

S6 = scene("If you withdraw, the server throws the box away, and every copy of the donation is unreadable for good",
    hall(16, 44) + f'<g class="gone">{use("letterbox", 128, 70, 44, 38, "terra")}</g>'
    + arrow("M100 96 C112 92, 120 90, 126 90") + arrow("M150 112 V140") + use("bin", 128, 142, 44, 50)
    + use("locked", 40, 150, 44, 36, "green") + f'<circle class="ring" cx="62" cy="168" r="30"/>'
    + use("laptop", 238, 46, 132, 102) + label(304, 36, "Researcher", "middle")
    + use("locked", 282, 66, 44, 36, "green") + f'<circle class="ring" cx="304" cy="84" r="30"/>'
    + label(200, 208, "every copy: unreadable for good", "middle", "cap"))

S7 = scene("Later: download your locked data as one file and open it on another computer with your password",
    browser(6, 30, 150, 170) + label(10, 22, COMPUTER)
    + use("locked", 28, 64, 62, 50, "gold") + use("box", 40, 130, 56, 48)
    + arrow("M160 112 H176") + use("file", 180, 78, 52, 62) + arrow("M236 112 H250")
    + label(206, 160, "package", "middle", "cap")
    + browser(254, 30, 140, 170) + label(258, 22, "Another computer")
    + use("pw", 270, 62, 88, 22) + use("locked", 268, 106, 52, 42, "gold") + use("box", 328, 110, 50, 43)
    + label(324, 188, "with your password", "middle", "cap"))

SYMBOLS = '''
<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>
<marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="ahead"/></marker>
<pattern id="hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)"><rect width="6" height="6" class="hbg"/><line x1="0" y1="0" x2="0" y2="6" class="hline"/></pattern>
<symbol id="key" viewBox="0 0 64 28"><path class="ol fc" d="M23 10h37v8h-6v7h-6v-7h-5v5h-6v-5h-14z"/><circle class="ol fc" cx="13" cy="14" r="11"/><circle class="ol fp" cx="13" cy="14" r="4"/></symbol>
<symbol id="box" viewBox="0 0 60 52"><rect class="ol fw" x="4" y="20" width="52" height="29" rx="4"/><path class="ol fw2" d="M4 22Q4 6 30 6Q56 6 56 22Z"/><path class="ol" d="M24 26v-4a6 6 0 0 1 12 0v4" fill="none"/><rect class="ol fc" x="21" y="26" width="18" height="14" rx="3"/></symbol>
<symbol id="boxopen" viewBox="0 0 60 52"><rect class="ol fw" x="4" y="20" width="52" height="29" rx="4"/><path class="ol fw2" d="M8 20L2 4Q16 -2 30 6L36 20Z"/><path class="ol fdark" d="M8 20h44v6H8z"/></symbol>
<symbol id="letterbox" viewBox="0 0 60 52"><rect class="ol fc" x="4" y="6" width="52" height="43" rx="6"/><rect class="ol fdark" x="14" y="14" width="32" height="5" rx="2.5"/><circle class="ol fp" cx="30" cy="33" r="5"/><path class="ol" d="M30 36v6"/></symbol>
<symbol id="cards" viewBox="0 0 70 56"><rect class="ol fp" x="14" y="2" width="54" height="38" rx="3" transform="rotate(4 41 21)"/><rect class="ol fp" x="2" y="14" width="56" height="40" rx="3"/><circle class="fmad" cx="15" cy="27" r="6"/><path class="ink2" d="M26 25h24M26 33h20M10 43h40"/></symbol>
<symbol id="locked" viewBox="0 0 70 56"><rect class="ol fh" x="14" y="2" width="54" height="38" rx="3" transform="rotate(4 41 21)"/><rect class="ol fh" x="2" y="14" width="56" height="40" rx="3"/><path class="ol" d="M24 30v-5a6 6 0 0 1 12 0v5" fill="none"/><rect class="ol fc" x="21" y="30" width="18" height="14" rx="3"/></symbol>
<symbol id="hall" viewBox="0 0 96 96"><path class="ol fp" d="M6 34L48 6L90 34Z"/><rect class="ol fp" x="10" y="34" width="76" height="8"/><rect class="ol fp" x="14" y="42" width="68" height="38"/><path class="ol" d="M26 46v30M40 46v30M56 46v30M70 46v30"/><rect class="ol fp" x="6" y="80" width="84" height="10"/><circle class="ol fmad" cx="48" cy="23" r="5"/></symbol>
<symbol id="laptop" viewBox="0 0 90 70"><rect class="ol fp" x="10" y="4" width="70" height="48" rx="4"/><path class="ol fw2" d="M2 58h86l-6 8H8z"/><path class="ol" d="M10 52h70v6H10z" fill="none"/></symbol>
<symbol id="bin" viewBox="0 0 40 46"><path class="ol fw2" d="M6 12h28l-3 31H9z"/><path class="ol" d="M2 12h36M15 12V6h10v6M15 19v18M25 19v18"/></symbol>
<symbol id="pw" viewBox="0 0 84 22"><rect class="ol fp" x="1" y="1" width="82" height="20" rx="5"/>''' + "".join(f'<circle class="fink" cx="{14+i*11}" cy="11" r="3"/>' for i in range(5)) + '''</symbol>
<symbol id="clock" viewBox="0 0 30 30"><circle class="ol fp" cx="15" cy="15" r="12"/><path class="ol" d="M15 8v7l5 3"/></symbol>
<symbol id="file" viewBox="0 0 52 62"><path class="ol fp" d="M2 2h34l14 14v44H2z"/><path class="ol" d="M36 2v14h14" fill="none"/><rect class="ol fh" x="9" y="24" width="34" height="18" rx="2"/><rect class="ol fw" x="15" y="46" width="22" height="10" rx="2"/></symbol>
</defs></svg>'''

def step(n, svg, title, paras, note=None, soon=False):
    badge = '<span class="soon">Coming later</span>' if soon else ""
    body = "".join(f"<p>{p}</p>" for p in paras)
    if note:
        body += f'<p class="note">{note}</p>'
    return (f'<section class="step" id="step-{n}"><div class="art">{svg}</div><div class="copy">'
            f'<div class="num">{n}{badge}</div><h2>{title}</h2>{body}</div></section>')

STEPS = [
    step(1, S1, "Participants' data is locked on their own computer", [
        "When a participant adds their data, the browser makes a <b>data key</b> that exists only on that computer, and encrypts everything with it. The data key goes into a small box (it is wrapped), which also stays on the computer.",
        "The key to that box is held by the Combray server, which hands it out only for the participant's password. Neither the computer alone nor the server alone can open the data.",
    ]),
    step(2, S3, "When they stop, the browser forgets", [
        "On closing the page, locking, or after 15 minutes without input, the browser throws away the keys and everything it decrypted. What remains on the disk is ciphertext and a closed box.",
        "This is what makes shared lab computers safe: the next person at the computer cannot open anything without the password, and password guessing is limited by the server.",
    ], note="You never get the data key. It covers everything a participant loaded, including what they choose not to share."),
    step(3, S4, "A donation gets its own key, locked for you", [
        "When a participant donates, they choose exactly what to share. The browser makes a fresh <b>donation key</b> for that selection, and seals it to your project's public key: like a letterbox, anyone can put a key in, only your project key opens it.",
        "The server stores the encrypted donation and the sealed key in separate places, and can open neither. The sealing uses a hybrid post-quantum construction (X-Wing), so recording the traffic today does not help an attacker with a future quantum computer.",
    ]),
    step(4, S5, "Your tools borrow the key, every time", [
        "You open donations on the <b>key page</b>, a small page of its own that you unlock with your passkey (Face ID, a fingerprint, or your phone). Every time, it fetches the sealed keys from the server, opens them with the project key, decrypts in memory, and throws the keys away when it is done. Later the R package will work the same way.",
        "The server keeps the project key only locked for each researcher, and your copy only locked under your passkey, so it cannot open anything itself. Nothing is installed on your computer, and nothing is left on it unless you save an export.",
    ]),
    step(5, S6, "Withdrawal reaches every copy", [
        "When a participant withdraws, or asks you to withdraw for them, the server deletes the sealed keys and the envelope, and keeps a note that the donation was withdrawn. Your tool then deletes its local copy too. Any copy that is left, anywhere, can no longer be opened.",
        "Backups of the server's key database could still hold a withdrawn key until they expire. The server's backup retention is a setting, 30 days by default, and participants are told that withdrawal is complete within that time.",
    ], note="Data you decrypt and save yourself is outside this protection. If you export a file, you are responsible for it under the GDPR, including deleting it when a participant withdraws."),
    step(6, S7, "Participants can take their locked data with them", [
        "Participants will be able to download a <b>Combray package</b>: their encrypted data and the closed box, in one file. It opens on any computer, but only after logging in with their password, and it stops working when they delete their data on the server.",
    ], soon=True),
]

TABLE = '''<div class="tablewrap"><table>
<thead><tr><th></th><th>Data on the participant's computer</th><th>Donations</th></tr></thead>
<tbody>
<tr><th>The participant, with their password</th><td><span class="yes">●</span>Yes</td><td><span class="yes">●</span>Yes, until withdrawn</td></tr>
<tr><th>Someone with the participant's computer</th><td><span class="no">○</span>No</td><td><span class="no">○</span>No</td></tr>
<tr><th>The server operator</th><td><span class="no">○</span>Only with the participant's computer too</td><td><span class="no">○</span>No</td></tr>
<tr><th>You, the researcher</th><td><span class="no">○</span>No</td><td><span class="yes">●</span>Yes, until withdrawn or you are removed from the project</td></tr>
<tr><th>Someone with your email</th><td><span class="no">○</span>No</td><td><span class="no">○</span>No: they also need your passkey or recovery code</td></tr>
</tbody></table></div>'''

CHECKLIST = '''<ul class="checks">
<li><b>Keep your recovery code safe</b>, printed or saved apart from your passkey. If you lose both, a colleague can give you access again; if nobody on the project has access, nobody can open the donations.</li>
<li><b>Compare key codes</b> when you give a colleague access, by phone or in person. It is what stops anyone slipping in a key of their own.</li>
<li><b>Analyse without saving.</b> Write scripts that start from the encrypted donations and fetch the keys, rather than saving decrypted data.</li>
<li><b>In R, turn off "Save workspace on exit"</b> (RStudio: Tools, Global Options, General, set it to Never). Otherwise <code>.RData</code> quietly keeps decrypted data.</li>
<li><b>Use a synced passkey</b> (iCloud Keychain, Google Password Manager, or a password manager), so losing a phone does not lock you out. Remove a lost device's passkey on the key page.</li>
<li><b>If you export data, you own that copy.</b> Keep a list of exports, so you can delete a participant's data when they withdraw.</li>
</ul>'''

R_SNIPPET = '''<pre><code>library(combray)

con &lt;- combray_connect(
  server  = "https://combray.uni.nl",
  project = "willow",
  key     = combray_device_key()     # added once from the key page
)

combray_sync(con)                 # new donations in, withdrawn ones out
yt &lt;- combray_read(con, dataset = "youtube_watch_history")  # decrypted in memory only</code></pre>'''

def keyitem(sym, color, name, text, w=56, h=24):
    st = f' style="color:{C[color]}"' if color else ""
    pos = f'x="2" y="{(52 - h) / 2}" width="{w}" height="{h}"' if sym == "key" else 'x="2" y="0" width="60" height="52"'
    return f'<li><svg viewBox="0 0 64 52" aria-hidden="true"><use href="#{sym}" {pos}{st}/></svg><p><b>{name}</b> {text}</p></li>'

LEGEND = '<ul class="legend">' + "".join([
    keyitem("key", "gold", "Data key.", "Encrypts a participant's local data. Never leaves their computer."),
    keyitem("box", None, "Small box.", "The wrapped data key, on the participant's computer."),
    keyitem("key", "dusk", "Box key.", "Held by the server, released only for the participant's password."),
    keyitem("key", "green", "Donation key.", "Fresh for every donation, covering only what was shared."),
    keyitem("letterbox", "terra", "Sealed key.", "The donation key sealed to your public key, kept by the server."),
    keyitem("key", "terra", "Project key.", "Opens sealed keys. Kept locked for each researcher, under their passkey."),
]) + "</ul>"

BODY = f'''
<div class="page">
<header class="top"><span class="brand">Combray for researchers</span></header>
<h1>Who holds the keys</h1>
<p class="lede">How Combray protects your participants' data, from their browser to your analysis, and what that means for how you work. Participants get their own version of this story in the app, under Questions.</p>
<ul class="cast">
<li><h3>The participant's computer</h3><p>Holds their data, encrypted. It leaves only as a donation they choose.</p></li>
<li><h3>The Combray server</h3><p>Run by the university. Holds keys and encrypted donations, but can read neither the data nor the donations.</p></li>
<li><h3>The key page</h3><p>Unlocked with your passkey. Opens donations, in memory, while the participant allows it.</p></li>
</ul>
{LEGEND}
{"".join(STEPS)}
<h2 class="sec">Who can see what</h2>
{TABLE}
<h2 class="sec">What this asks of you</h2>
{CHECKLIST}
<h2 class="sec">Analysing in R</h2>
<p class="fine">The R package is planned. This is a sketch of how it will work; nothing is written to disk except the encrypted donations.</p>
{R_SNIPPET}
<footer>The full design, with every key, the constructions and the alternatives we rejected, is in <a href="https://github.com/kasperwelbers/Combray/blob/main/docs/key-design.md">key-design.md</a>; how you sign in and hold your keys is in <a href="https://github.com/kasperwelbers/Combray/blob/main/docs/researcher-keys.md">researcher-keys.md</a>.</footer>
</div>'''


STYLE = '''
<style>
/* Layout: one calm column; each step pairs an illustration with its story, stacking on phones. */
:root {
  --paper: #FBF6EC; --card: #FFFDF8; --ink: #3B2F2A; --muted: #6E6058; --line: #E6DAC6;
  --madeleine: #C98A3D; --tilleul: #A9B66F; --terracotta: #B5623F; --dusk: #6E6A9E; --hawthorn: #E8B7B0;
  --wood: #C49A6C; --wood2: #A97E52; --hatch: #D8C9B2;
  --display: "Fraunces", "EB Garamond", Georgia, serif;
  --body: "Source Sans 3", "Atkinson Hyperlegible", "Segoe UI", system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --paper: #1F1B23; --card: #2A2530; --ink: #EFE6D8; --muted: #B8AB9D; --line: #3E3644;
  --madeleine: #D9A05A; --tilleul: #B9C48A; --terracotta: #D27C57; --dusk: #A19CD6; --hawthorn: #E8B7B0;
  --wood: #9C7650; --wood2: #7E5E3F; --hatch: #4A4150; color-scheme: dark } }
:root[data-theme="dark"] {
  --paper: #1F1B23; --card: #2A2530; --ink: #EFE6D8; --muted: #B8AB9D; --line: #3E3644;
  --madeleine: #D9A05A; --tilleul: #B9C48A; --terracotta: #D27C57; --dusk: #A19CD6; --hawthorn: #E8B7B0;
  --wood: #9C7650; --wood2: #7E5E3F; --hatch: #4A4150; color-scheme: dark }
body { background: var(--paper); color: var(--ink); font: 18px/1.6 var(--body); }
.page { max-width: 960px; margin: 0 auto; padding-block: 28px 56px;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
header.top { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.brand { font: 600 15px/1 var(--body); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
h1 { font: 500 clamp(36px, 6vw, 56px)/1.08 var(--display); margin: 36px 0 14px; text-wrap: balance; max-width: 16ch; }
.lede { font-size: 20px; max-width: 60ch; margin: 0 0 28px; }
.cast { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin: 0 0 22px; padding: 0; list-style: none; }
.cast li { border-top: 3px solid var(--madeleine); padding-top: 10px; }
.cast li:nth-child(2) { border-color: var(--dusk); } .cast li:nth-child(3) { border-color: var(--terracotta); }
.cast h3 { font: 600 18px/1.3 var(--display); margin: 0 0 4px; }
.cast p { margin: 0; color: var(--muted); font-size: 16px; }
.legend { list-style: none; padding: 18px; margin: 0 0 40px; display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px 20px;
  background: var(--card); border: 1px solid var(--line); border-radius: 14px; }
.legend li { display: flex; gap: 12px; align-items: center; min-width: 0; }
.legend svg { width: 52px; height: 42px; flex: none; }
.legend p { margin: 0; font-size: 15.5px; line-height: 1.4; }
.step { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 28px; align-items: center; padding: 30px 0; border-top: 1px solid var(--line); }
.step:nth-of-type(even) .art { order: 2; }
.art { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 10px; }
.scene { display: block; width: 100%; height: auto; }
.copy { min-width: 0; }
.num { font: 500 15px/1 var(--body); color: var(--muted); display: flex; gap: 10px; align-items: center; font-variant-numeric: tabular-nums; }
.soon { font-size: 12.5px; letter-spacing: .06em; text-transform: uppercase; background: var(--hawthorn); color: #3B2F2A; padding: 4px 9px; border-radius: 999px; }
h2 { font: 500 clamp(24px, 3.4vw, 30px)/1.2 var(--display); margin: 8px 0 10px; text-wrap: balance; }
.copy p { margin: 0 0 10px; max-width: 62ch; }
.note { font-size: 16px; color: var(--muted); border-left: 3px solid var(--tilleul); padding-left: 12px; }
h2.sec { margin-top: 44px; }
.tablewrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; min-width: 520px; font-size: 16.5px; }
th, td { text-align: left; padding: 12px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
thead th { font-weight: 600; color: var(--muted); font-size: 15px; }
tbody th { font-weight: 600; }
.yes, .no { margin-right: 8px; } .yes { color: var(--tilleul); } .no { color: var(--muted); }
.fine { font-size: 15.5px; color: var(--muted); max-width: 66ch; }
footer { margin-top: 40px; padding-top: 18px; border-top: 1px solid var(--line); font-size: 15.5px; color: var(--muted); }
a { color: var(--dusk); }
.checks { padding-left: 1.2em; max-width: 70ch; } .checks li { margin: 0 0 10px; }
pre { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; overflow-x: auto; font-size: 14.5px; line-height: 1.5; }
code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }

/* SVG parts */
.ol { stroke: var(--ink); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.fc { fill: currentColor; } .fp { fill: var(--card); } .fw { fill: var(--wood); } .fw2 { fill: var(--wood2); }
.fh { fill: url(#hatch); } .hbg { fill: var(--card); } .hline { stroke: var(--hatch); stroke-width: 2.4; }
.fdark { fill: var(--ink); } .fmad { fill: var(--madeleine); } .fink { fill: var(--ink); }
.ink2 { stroke: var(--muted); stroke-width: 2.4; stroke-linecap: round; fill: none; }
.frame rect { fill: var(--paper); stroke: var(--ink); stroke-width: 2; } .frame line { stroke: var(--ink); stroke-width: 1.5; } .frame circle { fill: var(--muted); }
.arrow { fill: none; stroke: var(--ink); stroke-width: 2; stroke-linecap: round; }
.dashed { stroke-dasharray: 5 5; stroke: var(--muted); }
.ahead { fill: var(--ink); }
.ring { fill: none; stroke: var(--terracotta); stroke-width: 2; stroke-dasharray: 4 4; }
.gone { opacity: .5; }
.lbl { font: 600 13px var(--body); fill: var(--ink); } .cap { font: 12px var(--body); fill: var(--muted); }
@media (prefers-reduced-motion: no-preference) {
  .gone { animation: drift 3.2s ease-in-out infinite alternate; }
  @keyframes drift { from { opacity: .7; transform: translateY(0); } to { opacity: .35; transform: translateY(5px); } }
}
@media (max-width: 720px) {
  .step { grid-template-columns: minmax(0, 1fr); gap: 14px; }
  .step:nth-of-type(even) .art { order: 0; }
  body { font-size: 17px; }
}
</style>'''


HEAD_TITLE = '<title>Who holds the keys</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n'
FONTS = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Source+Sans+3:wght@400;600&display=swap">\n'

if out_fragment:
    open(out_fragment, "w").write(HEAD_TITLE + FONTS + STYLE + SYMBOLS + BODY)
# Repo copy: a full document, no external fonts (Combray makes no requests to Google, see design-identity.md).
open(out_repo, "w").write(
    '<!doctype html>\n<!-- Generated by build_keys.py: edit that script and run python3 docs/explainers/build_keys.py -->\n'
    '<html lang="en">\n<head>\n<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    + HEAD_TITLE.replace('<meta name="claude:viewport-fit-sides" content="cover">\n', '') + STYLE
    + '\n</head>\n<body>\n' + SYMBOLS + BODY + '\n</body>\n</html>\n')
