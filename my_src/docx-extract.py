# 课程 docx 解包（docs 学习管线，一次性工具）：正文→assets/<名>/text.md，
# 图片→assets/<名>/img_XXX.<ext>，打印每篇字数与图数。
# 用法：E:/xp_agent/mcp-tdx/.venv/Scripts/python.exe docx-extract.py
import re, zipfile
from pathlib import Path

docs_dir = Path.home() / ".mini-claude" / "stocks" / "docs"

for docx in sorted(docs_dir.glob("*.docx")):
    name = docx.stem
    out = docs_dir / "assets" / name
    out.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(docx) as z:
        xml = z.read("word/document.xml").decode("utf-8")
        # 段落边界→换行；w:t 文本聚合；控制/tab 处理
        xml = re.sub(r"</w:p>", "\n", xml)
        xml = re.sub(r"<w:tab[^>]*/>", "\t", xml)
        xml = re.sub(r"<w:br[^>]*/>", "\n", xml)
        parts = re.findall(r"<w:t[^>]*>([^<]*)</w:t>|(\n)", xml)
        text = "".join(a or b for a, b in parts).replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
        text = re.sub(r"\n{3,}", "\n\n", text)
        (out / "text.md").write_text(text, encoding="utf-8")
        imgs = [n for n in z.namelist() if n.startswith("word/media/") and "." in n.split("/")[-1]]
        for i, n in enumerate(sorted(imgs)):
            ext = n.rsplit(".", 1)[-1]
            (out / f"img_{i:03d}.{ext}").write_bytes(z.read(n))
    print(f"{name}: 正文 {len(text)} 字符, 图片 {len(imgs)} 张 → assets/{name}/")
