import zipfile

epub_path = "/Users/burnfan/Downloads/Shi Jie De Luo Ji  - [Mei ] Da Wei _Ha Wei.epub"

with zipfile.ZipFile(epub_path, 'r') as z:
    for name in sorted(z.namelist()):
        if name.endswith(('.html', '.xhtml')):
            content = z.read(name).decode('utf-8', errors='ignore')
            if 'filepos106746' in content:
                print(f"Found 'filepos106746' in {name}")
                # Print occurrences with context
                start = 0
                while True:
                    idx = content.find('filepos106746', start)
                    if idx == -1:
                        break
                    print(f"  Context: {content[max(0, idx-100):min(len(content), idx+150)]}")
                    start = idx + 1
