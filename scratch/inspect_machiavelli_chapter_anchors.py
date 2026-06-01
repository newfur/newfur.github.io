import zipfile

epub_path = "/Users/burnfan/Downloads/马基雅维里时刻：佛罗伦萨政治思想和大西洋-1763205861483.epub"

with zipfile.ZipFile(epub_path, 'r') as z:
    for name in z.namelist():
        if 'text00001.html' in name:
            content = z.read(name).decode('utf-8', errors='ignore')
            print("Found text00001.html. Length:", len(content))
            for filepos in ['filepos0000217012', 'filepos0000295123', 'filepos0000390995']:
                exists = filepos in content
                print(f"'{filepos}' exists: {exists}")
                if exists:
                    # Print context around it
                    idx = content.find(filepos)
                    print(f"  Context: {content[max(0, idx-50):min(len(content), idx+150)]}")
            break
