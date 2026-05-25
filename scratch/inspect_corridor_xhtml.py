import zipfile
import os

epub_path = "/Users/burnfan/Downloads/自由的窄廊：國家與社會如何決定自由的命運-1763215042245.epub"

with zipfile.ZipFile(epub_path, 'r') as z:
    ch1_path = "OEBPS/ch1.xhtml"
    if ch1_path in z.namelist():
        content = z.read(ch1_path).decode('utf-8', errors='ignore')
        print("ch1.xhtml content (first 2000 chars):")
        print(content[:2000])
        print("\nLength of ch1.xhtml:", len(content))
    else:
        print(f"{ch1_path} not found in zip!")
