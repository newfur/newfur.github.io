import zipfile
import re

epub_path = "/Users/burnfan/Downloads/Shi Jie De Luo Ji  - [Mei ] Da Wei _Ha Wei.epub"

# Let's search for tags like <img, <image, <svg in all xhtml/html files in the zip
img_pattern = re.compile(r'<(img|image|svg)[^>]*>', re.IGNORECASE)

with zipfile.ZipFile(epub_path, 'r') as z:
    for name in sorted(z.namelist()):
        if name.endswith(('.html', '.xhtml')):
            content = z.read(name).decode('utf-8', errors='ignore')
            matches = img_pattern.findall(content)
            if matches:
                print(f"File: {name} contains tags: {set(matches)}")
                # Print exact text of matching tags
                start = 0
                for match in img_pattern.finditer(content):
                    print(f"  Tag: {match.group(0)}")
