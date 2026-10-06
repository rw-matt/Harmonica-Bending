"""Build FAQPage JSON-LD from the visible answers in faq.html and insert it into <head>.

Run after editing any FAQ answer:  python3 scripts/build-faq-schema.py
"""
import html, json, re, sys

path = sys.argv[1] if len(sys.argv) > 1 else "faq.html"
src = open(path, encoding="utf-8").read()
BASE = "https://harmonicabending.com"
PAGE = f"{BASE}/faq"

def to_text(fragment):
    s = re.sub(r"\s+", " ", fragment)
    s = re.sub(r"</p>\s*", "\n\n", s)
    s = re.sub(r"<li[^>]*>\s*", "- ", s)
    s = re.sub(r"</li>\s*", "\n", s)
    s = re.sub(r"</ul>\s*", "\n", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s)
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r" *\n *", "\n", s)
    return re.sub(r"\n{3,}", "\n\n", s).strip()

questions = []
for m in re.finditer(r'<details class="qa card" id="([^"]+)"[^>]*>\s*<summary><span class="qn">\d+</span>(.*?)<svg.*?</summary>\s*<div class="answer">(.*?)</details>', src, re.S):
    qid, q, body = m.groups()
    body = body.split('<div class="resources">')[0]
    questions.append({
        "@type": "Question",
        "@id": f"{PAGE}#{qid}",
        "name": html.unescape(re.sub(r"<[^>]+>", "", q)).strip(),
        "url": f"{PAGE}#{qid}",
        "acceptedAnswer": {"@type": "Answer", "text": to_text(body)},
    })
assert len(questions) == 10, f"expected 10 questions, found {len(questions)}"

graph = {
    "@context": "https://schema.org",
    "@graph": [
        {
            "@type": "WebSite",
            "@id": f"{BASE}/#website",
            "url": f"{BASE}/",
            "name": "Harmonica Bending",
            "inLanguage": "en",
        },
        {
            "@type": "FAQPage",
            "@id": f"{PAGE}#faq",
            "url": PAGE,
            "name": "Harmonica Bending FAQ: How to Bend Notes on Harmonica",
            "description": "Plain answers to the ten most common harmonica bending questions, with free video lessons and sources linked under each one.",
            "inLanguage": "en",
            "dateModified": "2026-10-05",
            "isPartOf": {"@id": f"{BASE}/#website"},
            "about": {"@type": "Thing", "name": "Harmonica bending", "sameAs": "https://en.wikipedia.org/wiki/Harmonica_techniques"},
            "breadcrumb": {"@id": f"{PAGE}#breadcrumb"},
            "mainEntity": questions,
        },
        {
            "@type": "BreadcrumbList",
            "@id": f"{PAGE}#breadcrumb",
            "itemListElement": [
                {"@type": "ListItem", "position": 1, "name": "Harmonica Bending Trainer", "item": f"{BASE}/"},
                {"@type": "ListItem", "position": 2, "name": "Bending FAQ", "item": PAGE},
            ],
        },
    ],
}

block = '  <script type="application/ld+json">\n' + json.dumps(graph, ensure_ascii=False, indent=2) + "\n  </script>\n"
src = re.sub(r'  <script type="application/ld\+json">.*?</script>\n', "", src, flags=re.S)  # replace any previous copy
src = src.replace("</head>", block + "</head>", 1)
open(path, "w", encoding="utf-8").write(src)
print(f"Inserted FAQPage schema with {len(questions)} questions")
for q in questions:
    print("-", q["name"], f"({len(q['acceptedAnswer']['text'])} chars)")
