import zipfile
import re

epub_path = "/Users/burnfan/Downloads/Shi Jie De Luo Ji  - [Mei ] Da Wei _Ha Wei.epub"

with zipfile.ZipFile(epub_path, 'r') as z:
    for name in z.namelist():
        if 'index_split_006.html' in name:
            content = z.read(name).decode('utf-8', errors='ignore')
            
            # Print around filepos106746 and filepos60888
            for target in ['filepos106746', 'filepos60888', 'filepos66521', 'filepos106977']:
                idx = content.find(target)
                if idx != -1:
                    print(f"\n--- HTML around '{target}' ---")
                    print(content[max(0, idx-100):min(len(content), idx+300)])
                else:
                    print(f"Target '{target}' not found!")
            break
