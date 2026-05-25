import zipfile
import re

epub_path = "/Users/burnfan/Downloads/自由的窄廊：國家與社會如何決定自由的命運-1763215042245.epub"

# Find tags matching <tagname ... />
tag_re = re.compile(r'<([a-zA-Z0-9:]+)([^>]*?)\/>')

self_closing_counts = {}

with zipfile.ZipFile(epub_path, 'r') as z:
    for name in z.namelist():
        if name.endswith('.xhtml') or name.endswith('.html'):
            content = z.read(name).decode('utf-8', errors='ignore')
            for match in tag_re.finditer(content):
                tag_name = match.group(1)
                self_closing_counts[tag_name] = self_closing_counts.get(tag_name, 0) + 1
                if tag_name in ['script', 'style', 'div', 'p', 'span', 'iframe', 'a']:
                    print(f"File {name}: found problematic self-closing tag: <{tag_name} {match.group(2)}/>")

print("\nAll self-closing tags count:")
for tag, count in self_closing_counts.items():
    print(f"  {tag}: {count}")
