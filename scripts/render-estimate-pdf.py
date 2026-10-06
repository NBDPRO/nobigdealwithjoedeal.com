#!/usr/bin/env python3
"""
Render an NBD estimate from its Google Doc plain-text export into a branded PDF.

House style per the two finished customer documents: Montserrat wordmark
over an orange rule, navy section headings with orange numerals, Lato body,
navy-header pricing tables, GAF/TAMKO badge row, checkbox acceptance page,
closing tagline.

TWO RULES THIS ENFORCES MECHANICALLY
  1. The "INTERNAL NOTES — DELETE THIS BLOCK BEFORE SENDING" block is removed.
     These are notes to Joe about pricing reasoning and missing data; they must
     never reach a homeowner.
  2. Nothing else is dropped. Every non-empty source line that survives the
     internal-notes cut is asserted to appear in the rendered text. A styling
     pass that silently loses a term or an exclusion is worse than no styling,
     because the omission is invisible in the output.
"""
import html
import re
import sys
import unicodedata
from pathlib import Path

NAVY = "#1A3057"
ORANGE = "#BD5728"

SENTINEL = "INTERNAL NOTES"


def strip_internal(text: str) -> tuple[str, str]:
    """Split the doc at the internal-notes sentinel. Returns (client, internal)."""
    lines = text.split("\n")
    cut = None
    for i, ln in enumerate(lines):
        if SENTINEL in ln.replace("\\", ""):
            cut = i
            break
    if cut is None:
        return text, ""
    # Walk back over the ==== rule and blank lines above the sentinel.
    j = cut
    while j > 0 and (not lines[j - 1].strip() or set(lines[j - 1].strip().replace("\\", "")) <= {"="}):
        j -= 1
    return "\n".join(lines[:j]), "\n".join(lines[cut:])


def unescape(s: str) -> str:
    """Undo the markdown escaping the Docs export applies."""
    s = re.sub(r"\\([\[\]_>#~=*`\\])", r"\1", s)
    return s


def norm_for_check(s: str) -> str:
    s = unicodedata.normalize("NFKC", unescape(s))
    # Leading list/callout/checkbox markers are rendered as styling (a real
    # bullet, an orange callout bar, a drawn checkbox) rather than as literal
    # characters, so they are not part of the text being compared.
    s = re.sub(r"^\s*(?:•|>>|\[\s*\])\s*", "", s)
    # Brackets around an unfilled placeholder are replaced by a visual badge,
    # so compare on the placeholder word itself rather than its punctuation.
    s = s.replace("[", "").replace("]", "")
    return re.sub(r"[\s_.·]+", "", s)


PRICE = r"\$[\d,]+(?:\.\d{2})?"


LOGO = Path(__file__).with_name("assets") / "nbd-wordmark.png"


def logo_tag() -> str:
    """The real NBD wordmark, embedded so the PDF carries no external refs.

    Falls back to the typeset wordmark if the asset is missing, so the script
    still produces a usable document on a machine without it.
    """
    import base64
    if not LOGO.exists():
        return ('<div class="wordmark">NO BIG DEAL'
                '<span class="wm2">HOME SOLUTIONS</span></div>')
    b64 = base64.b64encode(LOGO.read_bytes()).decode()
    return f'<img class="logo" src="data:image/png;base64,{b64}" alt="No Big Deal Home Solutions">'


LETTERHEAD_MARKS = (
    "NO BIG DEAL HOME SOLUTIONS",
    "ROOFING · SIDING",
    "NOBIGDEALWITHJOEDEAL.COM",
    "JOE DEAL — OWNER",
    "LICENSED & INSURED",
    "GAF CERTIFIED",
    "TAMKO PRO GOLD",
    "SERVING GREATER CINCINNATI",
)


def letterhead_end(lines: list[str]) -> int:
    """Index just past the letterhead block at the top of the document.

    Earlier this keyed on "Licensed & Insured"/"TAMKO Pro Gold" alone. The
    Customer DU invoice carries neither, so its whole letterhead was rendered as
    body text under a fallback title. Scan the leading block instead and stop
    at the first line that is not letterhead.
    """
    end = 0
    for i, ln in enumerate(lines[:14]):
        t = ln.strip()
        if not t:
            continue
        if any(m in t.upper() for m in LETTERHEAD_MARKS):
            end = i + 1
            continue
        break
    return end


def pay_block(url: str) -> str:
    """Orange pay button plus a QR of the same URL, embedded as a data URI."""
    import base64
    import io
    try:
        import segno
    except ImportError:
        return f'<p class="body"><a class="paylink" href="{html.escape(url)}">{html.escape(url)}</a></p>'
    buf = io.BytesIO()
    segno.make(url, error="m").save(buf, kind="png", scale=6, border=2, dark="#1A3057")
    b64 = base64.b64encode(buf.getvalue()).decode()
    return (
        '<div class="pay">'
        f'<a class="paybtn" href="{html.escape(url)}">Pay this invoice online &rarr;</a>'
        f'<img class="qr" src="data:image/png;base64,{b64}" alt="QR code to pay online">'
        '</div>'
        f'<div class="payurl">{html.escape(url)}</div>'
    )


def is_heading(line: str) -> bool:
    t = line.strip()
    if not t or line.startswith(" "):
        return False
    letters = [c for c in t if c.isalpha()]
    if len(letters) < 3:
        return False
    return all(c.isupper() for c in letters)


def render(text: str, title_hint: str) -> str:
    client, _ = strip_internal(text)
    raw_lines = client.split("\n")

    # Drop the letterhead block — the masthead below replaces it — but keep it
    # for the contact strip so nothing is invented.
    lines = raw_lines[letterhead_end(raw_lines):]

    out = []
    i = 0
    n = len(lines)
    doc_title, doc_sub = "", ""

    # Leading centred title lines.
    lead = []
    while i < n and len(lead) < 2:
        t = lines[i].strip()
        if not t:
            i += 1
            continue
        if lines[i].startswith("      ") and t == t.upper() and any(c.isalpha() for c in t):
            lead.append(t)
            i += 1
            continue
        if lead and lines[i].startswith("      "):
            lead.append(t)
            i += 1
            continue
        break
    if lead:
        doc_title = lead[0]
        doc_sub = lead[1] if len(lead) > 1 else ""

    def flush_para(buf):
        # The Docs export is hard-wrapped at ~70 columns. Those newlines are an
        # artefact of the source, not the author's line breaks, so the lines are
        # joined back into flowing prose and re-wrapped by the layout engine.
        if buf:
            out.append('<p class="body">' + html.escape(unescape(" ".join(buf))) + "</p>")
            buf.clear()

    para: list[str] = []
    in_list = False

    def close_list():
        nonlocal in_list
        if in_list:
            out.append("</ul>")
            in_list = False

    while i < n:
        raw = lines[i]
        t = raw.strip()
        u = unescape(t)

        if not t:
            flush_para(para)
            close_list()
            i += 1
            continue

        # The doc repeats its own footer at the end. That information is set as
        # the running page footer on every page, so printing it again here is
        # duplication, not content.
        if ("nobigdealwithjoedeal.com" in u and "(859) 420-7382" in u) \
                or u.startswith("Serving Greater Cincinnati") \
                or u.upper().startswith("NO BIG DEAL HOME SOLUTIONS \u00b7") \
                or u.startswith("No Big Deal with Joe Deal \u2014 seriously"):
            flush_para(para)
            close_list()
            i += 1
            continue

        # ── invoice column-header row ("DESCRIPTION            AMOUNT") ────
        # Two column labels separated by a run of spaces. Left as a heading it
        # collapses to the single nonsense phrase "DESCRIPTION AMOUNT".
        m = re.match(r"^([A-Z][A-Z ]*[A-Z])\s{4,}(AMOUNT|PRICE|TOTAL)\s*$", u)
        if m:
            flush_para(para)
            close_list()
            out.append(
                f'<div class="thead"><span>{html.escape(m.group(1).strip())}</span>'
                f'<span class="amt-h">{html.escape(m.group(2))}</span></div>'
            )
            i += 1
            continue

        # ── invoice line item ("Siding Refasten & Re-Lock      $800.00") ────
        # Top-level, mixed case, amount set off by a run of spaces. Without
        # this the price renders inline in the sentence instead of in the
        # amount column.
        m = re.match(rf"^(\S.*?)\s{{2,}}({PRICE}|NO CHARGE|INCLUDED)\s*$", u)
        # is_heading() wins: "OPTION 1 — PREMIUM MICROMESH   $3,422" is a
        # section heading that happens to carry a price, not a line item.
        if m and not raw.startswith(" ") and not u.startswith("[") and not is_heading(raw):
            flush_para(para)
            close_list()
            free = m.group(2) in ("NO CHARGE", "INCLUDED")
            out.append(
                f'<div class="item"><span class="d">{html.escape(m.group(1).strip())}</span>'
                f'<span class="amt{" free" if free else ""}">{html.escape(m.group(2))}</span></div>'
            )
            i += 1
            continue

        # ── totals stack line (SUBTOTAL / PAYMENTS RECEIVED / TAX) ────────
        m = re.match(rf"^(SUBTOTAL|PAYMENTS RECEIVED|TAX|DISCOUNT|AMOUNT PAID)\s+({PRICE})\s*$", u)
        if m:
            flush_para(para)
            close_list()
            out.append(
                f'<div class="lead sub-tot"><span>{html.escape(m.group(1))}</span>'
                f'<span class="dots"></span><span class="amt">{html.escape(m.group(2))}</span></div>'
            )
            i += 1
            continue

        # ── BALANCE DUE bar ────────────────────────────────────────────────
        m = re.match(rf"^BALANCE DUE\s+({PRICE})\s*$", u)
        if m:
            flush_para(para)
            close_list()
            out.append(
                f'<div class="balance"><span>BALANCE DUE</span>'
                f'<span class="bamt">{html.escape(m.group(1))}</span></div>'
            )
            i += 1
            continue

        # ── section heading, optionally with a trailing price ──────────────
        if is_heading(raw):
            flush_para(para)
            close_list()
            m = re.match(rf"^(.*?)\s+({PRICE})$", u)
            if m:
                out.append(
                    f'<h2 class="sect priced"><span>{html.escape(m.group(1).strip())}</span>'
                    f'<span class="amt">{html.escape(m.group(2))}</span></h2>'
                )
            else:
                out.append(f'<h2 class="sect">{html.escape(u)}</h2>')
            i += 1
            continue

        # ── indented sub-heading with a price or "INCLUDED" tail ───────────
        m = re.match(rf"^\s{{2,}}([A-Z][A-Z0-9 &,\'\-–—/]+?)\s{{2,}}({PRICE}|INCLUDED WITH [A-Z])\s*$", u)
        if m:
            flush_para(para)
            close_list()
            out.append(
                f'<h3 class="sub priced"><span>{html.escape(m.group(1).strip())}</span>'
                f'<span class="amt">{html.escape(m.group(2))}</span></h3>'
            )
            i += 1
            continue

        # ── all-caps indented sub-heading, no price ────────────────────────
        if re.match(r"^\s{3,}[A-Z][A-Z &/]{3,}$", u):
            flush_para(para)
            close_list()
            out.append(f'<h3 class="sub">{html.escape(u.strip())}</h3>')
            i += 1
            continue

        # ── acceptance checkbox ────────────────────────────────────────────
        # Price may be set off by dot leaders OR simply by a run of spaces.
        m = re.match(rf"^\[\s*\]\s*(.*?)(?:\s*(?:\.{{2,}}|\s{{2,}})\s*({PRICE}))?\s*$", u)
        if m:
            flush_para(para)
            close_list()
            amt = f'<span class="amt">{html.escape(m.group(2))}</span>' if m.group(2) else ""
            out.append(
                f'<div class="accept"><span class="box"></span>'
                f'<span class="lbl">{html.escape(m.group(1).strip())}</span>{amt}</div>'
            )
            i += 1
            continue

        # ── dot-leader money line ──────────────────────────────────────────
        # The value is usually a price, but a measurement schedule uses the same
        # dot-leader shape ("Gutter run (eaves) ..... 122 linear feet"). Both
        # are leader rows; only the price gets the orange amount treatment.
        m = re.match(r"^(.*?)\s*\.{3,}\s*(\S.{0,38})\s*$", u)
        if m and not m.group(2).endswith("."):
            flush_para(para)
            close_list()
            label, val = m.group(1).strip(), m.group(2).strip()
            cls = "tot" if re.match(r"^(ALL FOUR|OPTION \d+ TOTAL|TOTAL)", label, re.I) else ""
            is_money = bool(re.fullmatch(rf"{PRICE}|included", val, re.I))
            out.append(
                f'<div class="lead {cls}"><span>{html.escape(label)}</span>'
                f'<span class="dots"></span>'
                f'<span class="{"amt" if is_money else "val"}">{html.escape(val)}</span></div>'
            )
            i += 1
            continue

        # ── bare TOTAL line ────────────────────────────────────────────────
        m = re.match(rf"^TOTAL\s+({PRICE})$", u)
        if m:
            flush_para(para)
            close_list()
            out.append(
                f'<div class="lead tot"><span>TOTAL</span><span class="dots"></span>'
                f'<span class="amt">{html.escape(m.group(1))}</span></div>'
            )
            i += 1
            continue

        # ── payment link → button + scannable QR ───────────────────────────
        # A bare URL in a client document is not something a homeowner can act
        # on from paper. Rendered as a button plus a QR it becomes payable from
        # the printed page, which is what the doc says it does.
        m = re.match(r"^(https://\S+)$", u)
        if m:
            flush_para(para)
            close_list()
            out.append(pay_block(m.group(1)))
            i += 1
            continue

        # ── rule of dashes ─────────────────────────────────────────────────
        if set(u) <= {"-", " "} and "-" in u:
            i += 1
            continue

        # ── bullet ─────────────────────────────────────────────────────────
        if u.startswith("• "):
            flush_para(para)
            item = [u[2:].strip()]
            i += 1
            while i < n and lines[i].strip() and not lines[i].strip().startswith("•") \
                    and lines[i].startswith("     ") and not is_heading(lines[i]):
                item.append(lines[i].strip())
                i += 1
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append("<li>" + html.escape(unescape(" ".join(item))) + "</li>")
            continue

        # ── >> callout ─────────────────────────────────────────────────────
        if u.startswith(">>"):
            flush_para(para)
            close_list()
            item = [u.lstrip("> ").strip()]
            i += 1
            while i < n and lines[i].strip() and lines[i].startswith("      "):
                item.append(lines[i].strip())
                i += 1
            out.append('<div class="callout">' + html.escape(unescape(" ".join(item))) + "</div>")
            continue

        # ── signature rule ─────────────────────────────────────────────────
        if set(u.replace(" ", "")) <= {"_"} and len(u) > 10:
            flush_para(para)
            close_list()
            # The caption ("Customer BQ        Date") sits below the rule, but the
            # Docs export puts a blank line between them. Look past blanks —
            # otherwise the caption falls through and gets rendered as a
            # detail row, which is how "Customer BQ / Date" ended up looking
            # like an estimate field.
            names = []
            j = i + 1
            while j < n and not lines[j].strip():
                j += 1
            if j < n and lines[j].strip() and "_" not in lines[j]:
                names = re.split(r"\s{2,}", unescape(lines[j].strip()))
                i = j
            left = names[0] if names else ""
            right = names[1] if len(names) > 1 else "Date"
            out.append(
                f'<div class="sig"><div class="sigline"><span class="rule"></span>'
                f'<span class="cap">{html.escape(left)}</span></div>'
                f'<div class="sigline date"><span class="rule"></span>'
                f'<span class="cap">{html.escape(right)}</span></div></div>'
            )
            i += 1
            continue

        # ── fill-in field ("Total authorized: $ ____", "Color: ____") ──────
        if "_____" in u:
            flush_para(para)
            close_list()
            label = re.split(r"_{3,}", u)[0].strip()
            out.append(f'<div class="field"><span>{html.escape(label)}</span><span class="rule"></span></div>')
            i += 1
            continue

        # ── two-column detail row (label + value, wide gap) ────────────────
        m = re.match(r"^\s{3,}([A-Za-z][A-Za-z .&/]+?)\s{2,}(\S.*)$", raw)
        if m and not raw.strip().startswith("•"):
            flush_para(para)
            close_list()
            out.append(
                f'<div class="kv"><span class="k">{html.escape(unescape(m.group(1).strip()))}</span>'
                f'<span class="v">{html.escape(unescape(m.group(2).strip()))}</span></div>'
            )
            i += 1
            continue

        para.append(t)
        i += 1

    flush_para(para)
    close_list()

    body = "\n".join(out)

    # An unfilled [PLACEHOLDER] must be impossible to miss. Left as plain text
    # it reads as part of the document and can be sent by accident — which is
    # exactly what the internal note on the Customer BF estimate warns about.
    body = re.sub(
        r"\[([A-Z][A-Z ]{2,})\]",
        r'<span class="todo">\1 — TO BE FILLED</span>',
        body,
    )
    # "[CONFIRM — house number and zip]" is the same kind of hole, written in
    # sentence case. Badge it too, or it reads as ordinary text and ships.
    body = re.sub(
        r"\[(CONFIRM[^\]\n]*)\]",
        r'<span class="todo">\1</span>',
        body,
    )

    logo = logo_tag()
    masthead = f"""
    <div class="mast">
      {logo}
      <div class="contact">
        Joe Deal — Owner<br>
        (859) 420-7382<br>
        jd@nobigdealwithjoedeal.com<br>
        nobigdealwithjoedeal.com
      </div>
    </div>
    <div class="rule"></div>
    <div class="tagline">Roofing · Siding · Gutters · Storm Restoration &nbsp;·&nbsp; Licensed &amp; Insured (Ohio)</div>
    <h1>{html.escape(doc_title or title_hint)}</h1>
    {f'<div class="subtitle">{html.escape(doc_sub)}</div>' if doc_sub else ''}
    """

    badges = """
    <div class="badges">
      <span>GAF Certified™ Contractor #1162011</span>
      <span>TAMKO Pro Gold™ #181382</span>
    </div>
    """

    footer = """
    <div class="closing">No Big Deal with Joe Deal — seriously, it's in the name.</div>
    """

    css = f"""
    @page {{ size: Letter; margin: 16mm 15mm 18mm 15mm;
      @bottom-center {{ content: "No Big Deal Home Solutions · (859) 420-7382 · jd@nobigdealwithjoedeal.com · page " counter(page) " of " counter(pages);
        font-family: Lato; font-size: 7.5pt; color: #7c8794; }} }}
    body {{ font-family: Lato, sans-serif; font-size: 9.6pt; line-height: 1.5; color: #22303c; }}
    .mast {{ display: flex; justify-content: space-between; align-items: flex-end; }}
    .logo {{ width: 168pt; height: auto; display: block; }}
    .wordmark {{ font-family: Montserrat; font-weight: 800; font-size: 22pt; letter-spacing: .02em;
      color: {NAVY}; line-height: 1; }}
    .wm2 {{ display: block; font-size: 9.5pt; font-weight: 600; letter-spacing: .28em; color: {ORANGE}; margin-top: 3pt; }}
    .contact {{ text-align: right; font-size: 8.2pt; color: #4a5a68; line-height: 1.45; }}
    .rule {{ height: 3pt; background: {ORANGE}; margin: 7pt 0 0; }}
    .tagline {{ font-size: 7.8pt; letter-spacing: .06em; color: #6b7885; margin: 5pt 0 16pt; text-transform: uppercase; }}
    h1 {{ font-family: Montserrat; font-weight: 800; font-size: 17pt; color: {NAVY};
      margin: 0 0 2pt; letter-spacing: .01em; }}
    .subtitle {{ font-family: Montserrat; font-weight: 500; font-size: 10.5pt; color: {ORANGE}; margin-bottom: 14pt; }}
    h2.sect {{ font-family: Montserrat; font-weight: 700; font-size: 10.5pt; color: {NAVY};
      margin: 17pt 0 6pt; padding-bottom: 3pt; border-bottom: 1.2pt solid #d9e0e7; letter-spacing: .04em; }}
    h2.priced, h3.priced {{ display: flex; justify-content: space-between; align-items: baseline; gap: 10pt; }}
    h3.sub {{ font-family: Montserrat; font-weight: 700; font-size: 9.2pt; color: {NAVY};
      margin: 11pt 0 4pt; letter-spacing: .05em; }}
    .amt {{ font-family: Montserrat; font-weight: 800; color: {ORANGE}; white-space: nowrap; }}
    p.body {{ margin: 0 0 7pt; }}
    ul {{ margin: 3pt 0 8pt; padding-left: 13pt; }}
    li {{ margin-bottom: 3pt; }}
    .callout {{ border-left: 3pt solid {ORANGE}; background: #fdf4ea; padding: 7pt 9pt;
      margin: 8pt 0 10pt; font-weight: 600; color: {NAVY}; }}
    .kv {{ display: flex; gap: 10pt; margin-bottom: 2.5pt; }}
    .kv .k {{ min-width: 108pt; color: #61707e; }}
    .kv .v {{ font-weight: 600; color: {NAVY}; }}
    .lead {{ display: flex; align-items: baseline; gap: 5pt; margin-bottom: 3pt; }}
    .lead .dots {{ flex: 1; border-bottom: 1pt dotted #b9c4ce; transform: translateY(-2pt); }}
    .lead.tot {{ margin-top: 6pt; padding-top: 6pt; border-top: 1.4pt solid {NAVY};
      font-family: Montserrat; font-weight: 800; color: {NAVY}; font-size: 11pt; }}
    .accept {{ display: flex; align-items: center; gap: 8pt; margin: 7pt 0;
      border: 1pt solid #d9e0e7; border-left: 3pt solid {ORANGE}; padding: 7pt 9pt; }}
    .accept .box {{ width: 12pt; height: 12pt; border: 1.4pt solid {NAVY}; display: inline-block; flex: none; }}
    .accept .lbl {{ flex: 1; font-weight: 600; color: {NAVY}; }}
    .field {{ display: flex; align-items: baseline; gap: 8pt; margin: 10pt 0 4pt; }}
    .field .rule {{ flex: 1; height: 0; border-bottom: 1pt solid #93a1ad; background: none; margin: 0; }}
    .sig {{ display: flex; gap: 22pt; margin: 16pt 0 4pt; }}
    .sig .sigline {{ flex: 1; }}
    .sig .sigline.date {{ flex: 0 0 33%; }}
    .sig .rule {{ display: block; height: 0; border-bottom: 1pt solid #93a1ad; background: none; margin: 0 0 3pt; }}
    .sig .cap {{ font-size: 8pt; color: #61707e; }}
    .badges {{ display: flex; gap: 8pt; margin: 16pt 0 0; }}
    .badges span {{ border: 1pt solid #d9e0e7; border-radius: 3pt; padding: 4pt 8pt;
      font-size: 7.6pt; color: {NAVY}; font-weight: 600; }}
    h2.sect {{ break-after: avoid; }}
    .lead.sub-tot {{ font-family: Montserrat; font-weight: 600; font-size: 9.2pt; color: {NAVY}; }}
    .pay {{ break-inside: avoid; }}
    .lead .val {{ font-family: Montserrat; font-weight: 700; color: {NAVY}; white-space: nowrap; }}
    .thead {{ display: flex; justify-content: space-between; background: {NAVY}; color: #fff;
      font-family: Montserrat; font-weight: 700; font-size: 8.2pt; letter-spacing: .1em;
      padding: 5pt 9pt; margin: 16pt 0 0; }}
    .item {{ display: flex; justify-content: space-between; align-items: baseline; gap: 12pt;
      border-bottom: 1pt solid #e4e9ee; padding: 7pt 9pt 6pt; }}
    .item .d {{ font-family: Montserrat; font-weight: 700; font-size: 9.6pt; color: {NAVY}; }}
    .amt.free {{ color: #4f7a3f; font-size: 8.6pt; letter-spacing: .06em; }}
    .amt-h {{ font-family: Montserrat; font-weight: 700; }}
    .lead.tot {{ break-after: avoid; }}
    .balance {{ break-before: avoid; display: flex; justify-content: space-between; align-items: baseline;
      background: {NAVY}; color: #fff; padding: 9pt 11pt; margin: 8pt 0 4pt;
      font-family: Montserrat; font-weight: 700; font-size: 11pt; letter-spacing: .06em; }}
    .balance .bamt {{ font-weight: 800; font-size: 14pt; color: #FFB570; }}
    .pay {{ display: flex; align-items: center; gap: 14pt; margin: 10pt 0 4pt; }}
    .paybtn {{ background: {ORANGE}; color: #fff; text-decoration: none; font-family: Montserrat;
      font-weight: 800; font-size: 11pt; padding: 10pt 18pt; border-radius: 4pt; letter-spacing: .02em; }}
    .qr {{ width: 74pt; height: 74pt; }}
    .payurl {{ font-size: 6.6pt; color: #8b95a0; word-break: break-all; margin-bottom: 8pt; }}
    .todo {{ background: #ffe9d2; border: 1pt dashed {ORANGE}; color: #a5480a;
      font-weight: 700; font-size: 8pt; letter-spacing: .04em; padding: 1.5pt 5pt; border-radius: 2pt; }}
    .closing {{ margin-top: 12pt; padding-top: 8pt; border-top: 2pt solid {ORANGE};
      font-family: Montserrat; font-weight: 700; font-size: 9.5pt; color: {NAVY}; text-align: center; }}
    """

    return f"<html><head><meta charset='utf-8'><style>{css}</style></head><body>{masthead}{body}{badges}{footer}</body></html>"


def main():
    src, dest, hint = sys.argv[1], sys.argv[2], sys.argv[3]
    text = Path(src).read_text(encoding="utf-8")
    client, internal = strip_internal(text)
    doc_html = render(text, hint)

    # ── the no-silent-loss guard ───────────────────────────────────────────
    from weasyprint import HTML
    rendered_text = re.sub(r"<[^>]+>", " ", doc_html)
    rendered_norm = norm_for_check(html.unescape(rendered_text))

    # The letterhead block is not dropped — it is re-set as the masthead, which
    # carries the same company name, phone, email and site in a designed
    # arrangement. Exempt those specific lines rather than the whole check.
    src_lines = client.split("\n")
    lh_end = letterhead_end(src_lines)

    missing = []
    for k, ln in enumerate(src_lines):
        t = ln.strip()
        if not t or set(t) <= {"-", "=", "_", " "}:
            continue
        if k < lh_end:
            continue
        # The repeated footer line is likewise re-set as the running page footer.
        if "nobigdealwithjoedeal.com" in t and "(859) 420-7382" in t:
            continue
        if t.startswith("Serving Greater Cincinnati"):
            continue
        if t.upper().startswith("NO BIG DEAL HOME SOLUTIONS \u00b7"):
            continue
        if t.startswith("No Big Deal with Joe Deal \u2014 seriously"):
            continue
        frag = norm_for_check(t)
        if len(frag) < 6:
            continue
        if frag not in rendered_norm:
            missing.append(t)

    if internal:
        leaked = [w for w in ("INTERNALNOTES", "DELETETHISBLOCK") if w in rendered_norm.upper()]
        if leaked:
            raise SystemExit(f"ABORT: internal notes leaked into the client PDF: {leaked}")

    if missing:
        print(f"  !! {len(missing)} source line(s) not found in the render:")
        for m in missing[:12]:
            print(f"     {m[:100]}")
        raise SystemExit("ABORT: refusing to write a PDF that silently drops content.")

    HTML(string=doc_html).write_pdf(dest)
    print(f"  wrote {dest}  (internal notes stripped: {'yes' if internal else 'none present'})")


if __name__ == "__main__":
    main()
