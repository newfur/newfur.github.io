import zipfile
import re

epub_path = "/Users/burnfan/Downloads/自由的窄廊：國家與社會如何決定自由的命運-1763215042245.epub"

# Our regex in Python matching the JS regex
script_re = re.compile(r'<script([^>]*?)\/>', re.IGNORECASE)

with zipfile.ZipFile(epub_path, 'r') as z:
    ch1_path = "OEBPS/ch1.xhtml"
    if ch1_path in z.namelist():
        html_text = z.read(ch1_path).decode('utf-8', errors='ignore')
        
        print("Before fix:")
        print("Self-closing script tags found:", len(script_re.findall(html_text)))
        print("Standard script open tags found:", len(re.findall(r'<script[^>]*?[^\/]>', html_text)))
        print("Script close tags found:", len(re.findall(r'</script>', html_text)))
        
        # Preprocessing
        fixed_html = script_re.sub(r'<script\1></script>', html_text)
        
        print("\nAfter fix:")
        print("Self-closing script tags found:", len(script_re.findall(fixed_html)))
        print("Standard script open tags found:", len(re.findall(r'<script[^>]*?>', fixed_html)))
        print("Script close tags found:", len(re.findall(r'</script>', fixed_html)))
        
        # Verify the replaced tag looks correct
        for m in re.finditer(r'<script[^>]*?>.*?</script>', fixed_html, re.DOTALL):
            print("\nReplaced script element found:")
            print(m.group(0))
    else:
        print("ch1.xhtml not found!")
