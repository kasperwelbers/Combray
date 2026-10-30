"""Generates the key explainer page (artifact fragment and repo copy)."""
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

def label(x, y, en, nl, anchor="start", cls="lbl"):
    return (f'<text class="{cls} en" x="{x}" y="{y}" text-anchor="{anchor}">{en}</text>'
            f'<text class="{cls} nl" x="{x}" y="{y}" text-anchor="{anchor}">{nl}</text>')

def arrow(d, dashed=False):
    cls = "arrow dashed" if dashed else "arrow"
    return f'<path class="{cls}" d="{d}" marker-end="url(#ah)"/>'

def line(d):
    return f'<path class="arrow dashed" d="{d}"/>'

def hall(x, y, s=96):
    return use("hall", x, y, s, s) + label(x + s / 2, y - 10, "Server", "Server", "middle")

def scene(title_en, title_nl, body):
    return (f'<svg class="scene" viewBox="0 0 400 214" role="img">'
            f'<title class="en">{title_en}</title><title class="nl">{title_nl}</title>{body}</svg>')

COMPUTER = ("Your computer", "Jouw computer")

S1 = scene("Your data is locked with the data key; the data key goes into a box whose key the server keeps",
           "Je gegevens gaan op slot met de gegevenssleutel; die gaat in een kistje waarvan de server de sleutel heeft",
    browser(6, 22, 250, 186) + label(10, 15, *COMPUTER)
    + use("cards", 22, 54, 70, 56) + arrow("M98 82 H128") + use("locked", 134, 54, 70, 56, "gold")
    + label(57, 128, "your data", "je gegevens", "middle", "cap") + label(169, 128, "locked", "op slot", "middle", "cap")
    + use("key", 28, 150, 56, 24, "gold") + arrow("M90 162 H128") + use("box", 134, 140, 60, 52)
    + label(56, 192, "data key", "gegevenssleutel", "middle", "cap")
    + hall(292, 44) + use("key", 308, 156, 64, 28, "dusk")
    + line("M200 168 C240 176, 270 176, 302 170")
    + label(340, 202, "key to the box", "sleutel van het kistje", "middle", "cap"))

S2 = scene("Your password gets the box key from the server; the box opens and the data key unlocks your data",
           "Met je wachtwoord krijg je de sleutel van het kistje; het kistje gaat open en de gegevenssleutel opent je gegevens",
    browser(6, 22, 250, 186) + label(10, 15, *COMPUTER)
    + use("pw", 20, 50, 84, 22) + arrow("M108 61 C180 26, 250 34, 290 68")
    + label(62, 86, "your password", "je wachtwoord", "middle", "cap")
    + hall(292, 44)
    + arrow("M292 118 C262 122, 240 112, 222 104") + use("key", 162, 92, 56, 24, "dusk")
    + arrow("M190 120 V138") + use("boxopen", 168, 142, 60, 52)
    + arrow("M164 172 H152") + use("key", 98, 160, 52, 22, "gold")
    + arrow("M112 158 L80 136") + use("cards", 18, 92, 64, 51))

S3 = scene("When you stop, the browser throws away the keys and the readable data; locked data and a closed box remain",
           "Als je stopt, gooit de browser de sleutels en de leesbare gegevens weg; versleutelde gegevens en een dicht kistje blijven over",
    browser(6, 22, 250, 186) + label(10, 15, *COMPUTER)
    + use("locked", 22, 50, 70, 56, "gold") + use("box", 28, 130, 60, 52)
    + label(57, 202, "this stays", "dit blijft", "middle", "cap")
    + use("clock", 112, 48, 30, 30) + label(127, 92, "15 min", "15 min", "middle", "cap")
    + f'<g class="gone">{use("cards", 112, 110, 54, 43)}{use("key", 166, 68, 50, 21, "gold")}</g>'
    + arrow("M150 156 L186 168") + arrow("M200 94 L204 140") + use("bin", 184, 142, 44, 50)
    + hall(292, 44) + use("key", 308, 156, 64, 28, "dusk")
    + label(340, 202, "stays at the server", "blijft op de server", "middle", "cap"))

S4 = scene("You choose what to share; it is locked with a new donation key, which goes into the researcher's box; the server keeps both apart",
           "Jij kiest wat je deelt; dat gaat op slot met een nieuwe donatiesleutel, die in het kistje van de onderzoeker gaat; de server bewaart ze apart",
    browser(6, 22, 250, 186) + label(10, 15, *COMPUTER)
    + use("cards", 18, 52, 70, 56) + arrow("M94 80 H124") + use("locked", 130, 58, 58, 46, "green")
    + label(53, 126, "you choose", "jij kiest", "middle", "cap") + label(159, 122, "donation", "donatie", "middle", "cap")
    + use("key", 24, 150, 54, 23, "green") + arrow("M84 162 H112") + use("letterbox", 118, 138, 60, 52, "terra")
    + label(51, 192, "donation key", "donatiesleutel", "middle", "cap")
    + hall(292, 44)
    + arrow("M192 66 C250 20, 372 20, 368 142") + arrow("M182 170 C230 196, 270 190, 294 176")
    + use("letterbox", 296, 150, 44, 38, "terra") + use("locked", 346, 150, 44, 36, "green")
    + label(343, 206, "kept apart", "apart bewaard", "middle", "cap"))

S5 = scene("Each time, the researcher fetches the box from the server, opens it with the researcher key, reads, and throws the donation key away",
           "Elke keer haalt de onderzoeker het kistje op bij de server, opent het met de onderzoekerssleutel, leest, en gooit de donatiesleutel weg",
    hall(16, 44) + use("letterbox", 20, 150, 44, 38, "terra") + use("locked", 68, 150, 44, 36, "green")
    + arrow("M66 160 C130 120, 180 110, 238 104")
    + label(150, 100, "every time", "elke keer", "middle", "cap")
    + use("laptop", 238, 46, 132, 102) + label(304, 36, "Researcher", "Onderzoeker", "middle")
    + use("cards", 262, 58, 48, 38) + use("key", 318, 78, 40, 17, "green")
    + use("key", 160, 44, 52, 22, "terra") + arrow("M214 56 C226 58, 236 64, 244 74")
    + label(186, 36, "researcher key", "onderzoekerssleutel", "middle", "cap")
    + use("locked", 246, 162, 44, 36, "green") + label(268, 210, "stays locked", "blijft op slot", "middle", "cap")
    + arrow("M346 102 L354 150") + use("bin", 338, 152, 38, 44))

S6 = scene("If you withdraw, the server throws the box away, and every copy of the donation is unreadable for good",
           "Trek je je donatie in, dan gooit de server het kistje weg, en is elke kopie van de donatie voorgoed onleesbaar",
    hall(16, 44) + f'<g class="gone">{use("letterbox", 128, 70, 44, 38, "terra")}</g>'
    + arrow("M100 96 C112 92, 120 90, 126 90") + arrow("M150 112 V140") + use("bin", 128, 142, 44, 50)
    + use("locked", 40, 150, 44, 36, "green") + f'<circle class="ring" cx="62" cy="168" r="30"/>'
    + use("laptop", 238, 46, 132, 102) + label(304, 36, "Researcher", "Onderzoeker", "middle")
    + use("locked", 282, 66, 44, 36, "green") + f'<circle class="ring" cx="304" cy="84" r="30"/>'
    + label(200, 208, "every copy: unreadable for good", "elke kopie: voorgoed onleesbaar", "middle", "cap"))

S7 = scene("Later: download your locked data as one file and open it on another computer with your password",
           "Later: download je versleutelde gegevens als één bestand en open het op een andere computer met je wachtwoord",
    browser(6, 30, 150, 170) + label(10, 22, *COMPUTER)
    + use("locked", 28, 64, 62, 50, "gold") + use("box", 40, 130, 56, 48)
    + arrow("M160 112 H176") + use("file", 180, 78, 52, 62) + arrow("M236 112 H250")
    + label(206, 160, "package", "pakket", "middle", "cap")
    + browser(254, 30, 140, 170) + label(258, 22, "Another computer", "Andere computer")
    + use("pw", 270, 62, 88, 22) + use("locked", 268, 106, 52, 42, "gold") + use("box", 328, 110, 50, 43)
    + label(324, 188, "with your password", "met je wachtwoord", "middle", "cap"))

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

def tx(en, nl, tag="p", cls=""):
    c = f' class="{cls}"' if cls else ""
    return f'<{tag}{c}><span class="en">{en}</span><span class="nl">{nl}</span></{tag}>'

def step(n, svg, h_en, h_nl, paras, note=None, soon=False):
    badge = tx("Coming later", "Komt later", "span", "soon") if soon else ""
    body = "".join(tx(e, n_) for e, n_ in paras)
    if note:
        body += tx(note[0], note[1], "p", "note")
    return (f'<section class="step" id="step-{n}"><div class="art">{svg}</div><div class="copy">'
            f'<div class="num">{n}{badge}</div>{tx(h_en, h_nl, "h2")}{body}</div></section>')

STEPS = [
    step(1, S1, "Your data is locked on your own computer", "Je gegevens gaan op slot, op je eigen computer", [
        ("When you load your data, your browser makes a key that exists only on this computer: the <b>data key</b>. It locks your data with it, so what is stored on the disk cannot be read.",
         "Als je je gegevens inlaadt, maakt je browser een sleutel die alleen op deze computer bestaat: de <b>gegevenssleutel</b>. Daarmee gaan je gegevens op slot, zodat wat er op de schijf staat niet te lezen is."),
        ("The data key itself goes into a small box. The key to that box is kept by the server.",
         "De gegevenssleutel zelf gaat in een klein kistje. De sleutel van dat kistje bewaart de server.")]),
    step(2, S2, "Your password opens the box", "Je wachtwoord opent het kistje", [
        ("To look at your data again, you enter your password. The server checks it and hands over the key to the box. Your browser opens the box, takes out the data key and unlocks your data.",
         "Wil je je gegevens weer bekijken, dan vul je je wachtwoord in. De server controleert het en geeft de sleutel van het kistje. Je browser opent het kistje, pakt de gegevenssleutel en maakt je gegevens open."),
        ("Someone who tries to guess your password gets a few tries, and then has to wait longer and longer.",
         "Wie je wachtwoord probeert te raden, krijgt een paar pogingen en moet daarna steeds langer wachten.")]),
    step(3, S3, "When you stop, the browser forgets", "Als je stopt, vergeet de browser alles", [
        ("When you close the tab, press lock, or leave the computer alone for 15 minutes, the browser throws away the keys and everything it had opened.",
         "Sluit je het tabblad, klik je op vergrendelen, of laat je de computer een kwartier met rust, dan gooit de browser de sleutels weg, en alles wat open stond."),
        ("What stays behind is locked data and a closed box. Without the server and your password, nobody can open them, not even someone who takes the computer home.",
         "Wat overblijft, zijn versleutelde gegevens en een dicht kistje. Zonder de server en je wachtwoord kan niemand ze openen, ook niet iemand die de computer mee naar huis neemt.")]),
    step(4, S4, "Sharing: you choose, and only the researcher can open it", "Delen: jij kiest, en alleen de onderzoeker kan het openen", [
        ("If you decide to share, you pick exactly what. Your browser makes a new key just for this donation, the <b>donation key</b>, and locks your selection with it.",
         "Besluit je te delen, dan kies je precies wat. Je browser maakt een nieuwe sleutel speciaal voor deze donatie, de <b>donatiesleutel</b>, en doet je selectie daarmee op slot."),
        ("The donation key goes into the researcher's box. It works like a letterbox: anyone can put something in, but only the researcher has the key that opens it. The server keeps your donation and the box in separate places, and cannot open either.",
         "De donatiesleutel gaat in het kistje van de onderzoeker. Dat werkt als een brievenbus: iedereen kan er iets in doen, maar alleen de onderzoeker heeft de sleutel die hem opent. De server bewaart je donatie en het kistje op aparte plekken, en kan geen van beide openen.")],
        note=("The rest of your data stays on your computer. The researcher never gets the key to it.",
              "De rest van je gegevens blijft op je computer. De onderzoeker krijgt daar nooit de sleutel van.")),
    step(5, S5, "The researcher borrows the key, every time", "De onderzoeker leent de sleutel, elke keer opnieuw", [
        ("To study the donations, the researcher's program asks the server for the box each time. It opens the box with the researcher's own key, reads the donation, and throws the donation key away again when it is done.",
         "Om de donaties te bestuderen, vraagt het programma van de onderzoeker elke keer het kistje op bij de server. Het opent het kistje met de eigen sleutel van de onderzoeker, leest de donatie, en gooit de donatiesleutel daarna weer weg."),
        ("The locked donations may stay on the researcher's computer, but without a box from the server they cannot be read.",
         "De versleutelde donaties mogen op de computer van de onderzoeker blijven staan, maar zonder kistje van de server zijn ze niet te lezen.")]),
    step(6, S6, "If you change your mind, the box is thrown away", "Bedenk je je, dan gaat het kistje weg", [
        ("You can withdraw your donation. The server then throws away the box with the donation key. From that moment, every copy of your donation is unreadable, wherever it is, also on the researcher's computer. The server's last backups are gone within 30 days.",
         "Je kunt je donatie intrekken. De server gooit dan het kistje met de donatiesleutel weg. Vanaf dat moment is elke kopie van je donatie onleesbaar, waar die ook staat, ook op de computer van de onderzoeker. De laatste reservekopieën van de server zijn binnen 30 dagen weg.")],
        note=("Once the researcher has read your donation, they could in theory note something down or save a copy. Researchers promise not to, and their program makes not saving the easy way.",
              "Heeft de onderzoeker je donatie al gelezen, dan kan die in theorie iets opschrijven of een kopie bewaren. Onderzoekers beloven dat niet te doen, en hun programma maakt niet bewaren de makkelijke weg.")),
    step(7, S7, "Take your locked data with you", "Neem je versleutelde gegevens mee", [
        ("You will be able to download your data as one locked file, a <b>Combray package</b>. It opens on any computer, but only after you log in with your password.",
         "Je kunt je gegevens straks downloaden als één afgesloten bestand, een <b>Combray-pakket</b>. Het opent op elke computer, maar pas nadat je inlogt met je wachtwoord."),
        ("So you can keep it safe, move it to another computer, or delete the original download from your computer. If you ask Combray to delete everything, the package can no longer be opened either.",
         "Zo kun je het veilig bewaren, meenemen naar een andere computer, of de oorspronkelijke download van je computer verwijderen. Vraag je Combray om alles te verwijderen, dan gaat ook het pakket niet meer open.")],
        soon=True),
]

def keyitem(sym, color, en_name, nl_name, en, nl, w=56, h=24):
    st = f' style="color:{C[color]}"' if color else ""
    return (f'<li><svg viewBox="0 0 64 52" aria-hidden="true"><use href="#{sym}" x="2" y="{(52-h)/2 if sym=="key" else 0}" width="{60 if sym!="key" else w}" height="{52 if sym!="key" else h}"{st}/></svg>'
            f'<div>{tx("<b>"+en_name+"</b> "+en, "<b>"+nl_name+"</b> "+nl, "p")}</div></li>')

LEGEND = "<ul class=\"legend\">" + "".join([
    keyitem("key", "gold", "Data key.", "Gegevenssleutel.", "Locks your data. Only ever on your computer.", "Doet je gegevens op slot. Alleen op je computer."),
    keyitem("box", None, "Small box.", "Kistje.", "Holds your data key, on your computer.", "Bewaart je gegevenssleutel, op je computer."),
    keyitem("key", "dusk", "Box key.", "Kistjessleutel.", "Kept by the server, handed out only for your password.", "Bewaart de server, en geeft die alleen voor je wachtwoord."),
    keyitem("key", "green", "Donation key.", "Donatiesleutel.", "A new one for every donation, only for what you share.", "Een nieuwe voor elke donatie, alleen voor wat je deelt."),
    keyitem("letterbox", "terra", "Researcher's box.", "Kistje van de onderzoeker.", "Anyone can put a key in, only the researcher can open it.", "Iedereen kan er een sleutel in doen, alleen de onderzoeker kan het openen."),
    keyitem("key", "terra", "Researcher key.", "Onderzoekerssleutel.", "Only the researcher has it, on their own computer.", "Alleen de onderzoeker heeft die, op de eigen computer."),
]) + "</ul>"

def cell(ok, en, nl):
    mark = '<span class="yes" aria-hidden="true">●</span>' if ok else '<span class="no" aria-hidden="true">○</span>'
    return f'<td>{mark}<span class="en">{en}</span><span class="nl">{nl}</span></td>'

TABLE = f'''<div class="tablewrap"><table>
<thead><tr><th></th>{tx("Your data on your computer", "Je gegevens op je computer", "th")}{tx("What you shared", "Wat je hebt gedeeld", "th")}</tr></thead>
<tbody>
<tr>{tx("You, with your password", "Jij, met je wachtwoord", "th")}{cell(1, "Yes", "Ja")}{cell(1, "Yes, until you withdraw it", "Ja, tot je het intrekt")}</tr>
<tr>{tx("Someone with your computer", "Iemand met je computer", "th")}{cell(0, "No", "Nee")}{cell(0, "No", "Nee")}</tr>
<tr>{tx("The server", "De server", "th")}{cell(0, "No", "Nee")}{cell(0, "No", "Nee")}</tr>
<tr>{tx("The researcher", "De onderzoeker", "th")}{cell(0, "No", "Nee")}{cell(1, "Yes, until you withdraw it", "Ja, tot je het intrekt")}</tr>
</tbody></table></div>'''

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
[data-lang="en"] .nl, [data-lang="nl"] .en { display: none; }
.page { max-width: 960px; margin: 0 auto; padding-block: 28px 56px;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
header.top { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.brand { font: 600 15px/1 var(--body); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.lang { display: flex; border: 1.5px solid var(--line); border-radius: 999px; padding: 3px; gap: 2px; }
.lang button { font: 600 14px/1 var(--body); border: 0; background: none; color: var(--muted); padding: 8px 14px; border-radius: 999px; cursor: pointer; }
.lang button[aria-pressed="true"] { background: var(--ink); color: var(--paper); }
.lang button:focus-visible { outline: 2px solid var(--dusk); outline-offset: 2px; }
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

BODY = f'''
<div class="page">
<header class="top"><span class="brand">Combray</span>
<div class="lang" role="group" aria-label="Language / Taal"><button type="button" id="btn-en" data-set="en">English</button><button type="button" id="btn-nl" data-set="nl">Nederlands</button></div></header>
{tx("Who holds the keys", "Wie heeft de sleutels", "h1")}
{tx("Combray keeps your data locked. With keys and boxes, this page shows where your data is, who can open it, and what happens when you stop or change your mind.",
    "Combray houdt je gegevens op slot. Met sleutels en kistjes laat deze pagina zien waar je gegevens zijn, wie ze kan openen, en wat er gebeurt als je stopt of van gedachten verandert.", "p", "lede")}
<ul class="cast">
<li>{tx("Your computer", "Jouw computer", "h3")}{tx("Your data lives here, and only here, unless you share it.", "Hier staan je gegevens, en nergens anders, tenzij je ze deelt.")}</li>
<li>{tx("The Combray server", "De Combray-server", "h3")}{tx("Run by the university. It keeps keys and closed boxes, but can never read your data.", "Beheerd door de universiteit. Bewaart sleutels en dichte kistjes, maar kan je gegevens nooit lezen.")}</li>
<li>{tx("The researcher", "De onderzoeker", "h3")}{tx("Only ever sees what you choose to share.", "Ziet alleen wat jij kiest om te delen.")}</li>
</ul>
{LEGEND}
{"".join(STEPS)}
{tx("Who can see what", "Wie kan wat zien", "h2", "sec")}
{TABLE}
{tx("One honest footnote: someone who runs the server and also has your computer in their hands could, with both together, open the data on your computer. That is why the server is run by the university, under its rules, and why you can always delete everything when you are done.",
    "Eén eerlijke kanttekening: iemand die de server beheert én je computer in handen heeft, kan met die twee samen de gegevens op je computer openen. Daarom beheert de universiteit de server, volgens haar regels, en kun je altijd alles verwijderen als je klaar bent.", "p", "fine")}
<footer>{tx('The technical version, with every key and why we chose it, is in <a href="https://github.com/kasperwelbers/Combray/blob/main/docs/key-design.md">key-design.md</a>.',
    'De technische versie, met elke sleutel en waarom we ervoor kozen, staat in <a href="https://github.com/kasperwelbers/Combray/blob/main/docs/key-design.md">key-design.md</a> (Engels).')}</footer>
</div>
'''
SCRIPT = '''<script>
(function () {
  var root = document.documentElement;
  function set(lang, save) {
    root.setAttribute("data-lang", lang); root.lang = lang;
    document.getElementById("btn-en").setAttribute("aria-pressed", String(lang === "en"));
    document.getElementById("btn-nl").setAttribute("aria-pressed", String(lang === "nl"));
    if (save) { try { localStorage.setItem("combray-keys-lang", lang); } catch (e) {} }
  }
  var lang = null;
  try { lang = localStorage.getItem("combray-keys-lang"); } catch (e) {}
  if (lang !== "en" && lang !== "nl") lang = /^nl/i.test(navigator.language || "") ? "nl" : "en";
  set(lang, false);
  document.querySelectorAll(".lang button").forEach(function (b) { b.addEventListener("click", function () { set(b.dataset.set, true); }); });
})();
</script>'''

HEAD_TITLE = '<title>Who holds the keys</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n'
FONTS = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Source+Sans+3:wght@400;600&display=swap">\n'

BODY = BODY + SCRIPT
frag = HEAD_TITLE + FONTS + STYLE + SYMBOLS + BODY
if out_fragment:
    open(out_fragment, "w").write(frag)
# Repo copy: a full document, no external fonts (Combray makes no requests to Google, see design-identity.md).
repo = ('<!doctype html>\n<!-- Generated by build_keys.py: edit that script and run python3 docs/explainer/build_keys.py -->\n<html lang="en" data-lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        + HEAD_TITLE.replace('<meta name="claude:viewport-fit-sides" content="cover">\n', '') + STYLE + '\n</head>\n<body>\n' + SYMBOLS + BODY + '\n</body>\n</html>\n')
open(out_repo, "w").write(repo)
