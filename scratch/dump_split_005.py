import zipfile

epub_path = "/Users/burnfan/Downloads/Shi Jie De Luo Ji  - [Mei ] Da Wei _Ha Wei.epub"

with zipfile.ZipFile(epub_path, 'r') as z:
    for name in z.namelist():
        if 'index_split_005.html' in name:
            content = z.read(name).decode('utf-8', errors='ignore')
            print(f"--- Full Content of {name} ---")
            print(content)
            break
