# Builds resumes/*.docx from resumes/*.html: one column, real text, dates on a right tab stop.
# Resume parsers (YC, Wellfound, ATS forms) read this layout most reliably.
# Run: .venv/bin/python scripts/build-docx.py
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

from docx import Document
from docx.enum.text import WD_TAB_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

BLUE = RGBColor(0x1F, 0x3C, 0x88)
FONT = "Arial"


class Blocks(HTMLParser):
    """Turns the resume HTML into a flat list of (kind, text, extra) blocks."""

    def __init__(self):
        super().__init__()
        self.blocks, self.stack, self.buf, self.role = [], [], "", None

    def handle_starttag(self, tag, attrs):
        cls = dict(attrs).get("class", "")
        self.stack.append((tag, cls))
        if tag in ("h1", "h2", "p", "li") or (tag == "div" and cls in ("headline", "meta", "tag")):
            self.buf = ""
        if tag == "div" and cls == "role":
            self.role = {"title": "", "org": "", "dates": "", "part": "title"}
        if self.role is not None and tag == "span" and cls in ("org", "dates"):
            self.role["part"] = cls

    def handle_endtag(self, tag):
        tag_open, cls = self.stack.pop() if self.stack else (tag, "")
        text = re.sub(r"\s+", " ", self.buf).strip()
        if self.role is not None and tag == "div" and cls == "role":
            self.blocks.append(("role", self.role["title"].strip(" ·"), (self.role["org"].strip(), self.role["dates"].strip())))
            self.role = None
            return
        if self.role is not None:
            return
        if tag in ("h1", "h2", "p", "li") or (tag == "div" and cls in ("headline", "meta", "tag")):
            kind = {"h1": "name", "h2": "section", "p": "para", "li": "bullet"}.get(tag, cls)
            if text:
                self.blocks.append((kind, text, None))
            self.buf = ""

    def handle_data(self, data):
        if self.role is not None:
            self.role[self.role["part"]] += data
            if self.role["part"] in ("org", "dates") and self.stack and self.stack[-1][0] != "span":
                self.role["part"] = "title"
        else:
            self.buf += data


def run(p, text, size=9.5, bold=False, italic=False, color=None):
    r = p.add_run(text)
    r.font.name, r.font.size, r.bold, r.italic = FONT, Pt(size), bold, italic
    r._element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
    if color:
        r.font.color.rgb = color
    return r


def tight(p, before=0, after=1):
    f = p.paragraph_format
    f.space_before, f.space_after, f.line_spacing = Pt(before), Pt(after), 1.08


def rule_below(p):
    pPr = p._p.get_or_add_pPr()
    bdr = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    for k, v in (("w:val", "single"), ("w:sz", "6"), ("w:space", "1"), ("w:color", "1F3C88")):
        bottom.set(qn(k), v)
    bdr.append(bottom)
    pPr.append(bdr)


def build(html_file: Path, out: Path):
    parser = Blocks()
    parser.feed(html_file.read_text())
    doc = Document()
    sec = doc.sections[0]
    sec.page_width, sec.page_height = Inches(8.5), Inches(11)
    sec.left_margin = sec.right_margin = Inches(0.6)
    sec.top_margin = sec.bottom_margin = Inches(0.5)
    width = sec.page_width - sec.left_margin - sec.right_margin
    style = doc.styles["Normal"]
    style.font.name, style.font.size = FONT, Pt(9.5)

    for kind, text, extra in parser.blocks:
        if kind == "name":
            p = doc.add_paragraph(); tight(p, 0, 0); run(p, text, 20, bold=True)
        elif kind == "headline":
            p = doc.add_paragraph(); tight(p, 1, 0); run(p, text, 10.5, bold=True, color=BLUE)
        elif kind == "meta":
            p = doc.add_paragraph(); tight(p, 0, 0); run(p, text, 8.8)
        elif kind == "section":
            # A real heading style, so parsers can tell where each section starts.
            p = doc.add_paragraph(style="Heading 1"); tight(p, 7, 3)
            p.paragraph_format.keep_with_next = True
            run(p, text.upper(), 10, bold=True, color=BLUE); rule_below(p)
        elif kind == "role":
            # Company and dates on one line, title on the next: the layout resume parsers split jobs on.
            org, dates = extra
            dates = dates.replace("–", "-").replace("—", "-")
            p = doc.add_paragraph(); tight(p, 6, 0)
            p.paragraph_format.keep_with_next = True
            p.paragraph_format.tab_stops.add_tab_stop(width, WD_TAB_ALIGNMENT.RIGHT)
            run(p, org, 10, bold=True); run(p, f"\t{dates}", 9, bold=True)
            p = doc.add_paragraph(); tight(p, 0, 1)
            p.paragraph_format.keep_with_next = True
            run(p, text, 9.5, italic=True, color=BLUE)
        elif kind == "tag":
            p = doc.add_paragraph(); tight(p, 0, 1); run(p, text, 9, italic=True)
        elif kind == "bullet":
            p = doc.add_paragraph(style="List Bullet"); tight(p, 0, 1)
            p.paragraph_format.left_indent, p.paragraph_format.first_line_indent = Inches(0.2), Inches(-0.14)
            # "Signal Box (github...)" keeps its bold name
            m = re.match(r"^(Signal Box)(.*)$", text)
            if m:
                run(p, m.group(1), bold=True); run(p, m.group(2))
            else:
                run(p, text)
        else:
            p = doc.add_paragraph(); tight(p, 0, 1); run(p, text)
    doc.save(out)
    print(f"wrote {out}")


if __name__ == "__main__":
    folder = Path(__file__).resolve().parent.parent / "resumes"
    for html in sorted(folder.glob("*.html")):
        build(html, html.with_suffix(".docx"))
    sys.exit(0)
