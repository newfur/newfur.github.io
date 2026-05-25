import zipfile

epub_path = "/Users/burnfan/Downloads/自由的窄廊：國家與社會如何決定自由的命運-1763215042245.epub"

with zipfile.ZipFile(epub_path, 'r') as z:
    for name in z.namelist():
        if name.endswith('.xhtml') or name.endswith('.html'):
            content = z.read(name).decode('utf-8', errors='ignore')
            if '<script' in content:
                # Find all script tags
                start = 0
                while True:
                    idx = content.find('<script', start)
                    if idx == -1:
                        break
                    end = content.find('>', idx)
                    tag = content[idx:end+1]
                    print(f"File: {name} has script tag: {tag}")
                    # check if closed
                    if '/>' in tag:
                        print(f"  WARNING: Self-closing tag detected: {tag}")
                    start = end + 1
