# -*- coding: utf-8 -*-
import os

walkthrough_path = '/Users/burnfan/Documents/antigravity/mysterious-oppenheimer/walkthrough.md'
if not os.path.exists(walkthrough_path):
    walkthrough_path = '/Users/burnfan/.gemini/antigravity/brain/d54f9316-a338-4dc0-a78e-3d268a8155cc/walkthrough.md'

new_details = """
---

## 30. Implement Column-Specific Realistic 3D Curl-Flip Animations

我們對 3D 翻頁過渡效果進行了物理擬真重構，不再採用突兀的「全畫面繞中心軸旋轉」，而是依據「單頁」與「雙頁」分欄佈局動態調節翻頁的軸心與折疊捲曲軌跡：

### 1. 單頁與雙頁分欄狀態動態檢測
- 在佈局調整函數 `applyLayoutDimensions()` 中，每次重算列數時，程式會向 `document.body` 動態追加 `cols-1`、`cols-2` 或 `cols-3` 的 CSS 類別。
- 翻頁動畫的 CSS 選擇器利用 `html.transition-flip body.cols-X` 來精準區分當前排版模式，應用對應的 3D 軌跡。

### 2. 單頁閱讀模式 (cols-1) —— 側邊摺疊翻頁
- **物理特徵**：翻頁時，整張頁面應以**左側邊緣**為軸線向左翻動。
- **軌跡動畫**：
  - **前翻 (Forward)**：將 `transform-origin` 設為 `left center`。`::view-transition-old` 自 0度 旋轉至 負180度（翻至左側外）。為模擬從「右下角掀起」的手勢，動畫中加入了 `rotateZ(-8deg)` 的逆時針偏轉與 `translateY(-35px)` 的垂直上升。當過渡到 50% 處（垂直於螢幕的切面點），舊頁面隱藏，新頁面坐在下方直接顯現。
  - **後翻 (Backward)**：新頁面 `::view-transition-new` 自 負180度 旋轉至 0度，在 50% 處變為可見，並夾帶 Y 軸上升與 Z 軸偏轉，平滑向右落下蓋住舊頁面，完美契合書頁翻回的效果。

### 3. 雙頁閱讀模式 (cols-2) —— 右頁中央書脊翻頁
- **物理特徵**：雙頁顯示時，只有**右半邊的頁面**需要向左翻動蓋住左半邊，且軸線為**中央書脊線**。
- **軌跡動畫**：
  - **前翻 (Forward)**：將 `transform-origin` 設為 `center center`（對應中央書脊）。使用 `clip-path: inset(0 0 0 50%)` 對 `::view-transition-old` 進行裁剪，**僅保留右側頁面**。當右頁翻轉時，自 0度 旋轉至 負180度，伴隨 `rotateZ(-8deg)` 與 `translateY(-35px)` 的右下角掀開、捲曲上升效果，在過渡到 50% 處隱藏。此時，下層靜態的全新雙頁內容得以顯現。
  - **後翻 (Backward)**：新頁面 `::view-transition-new` 被裁剪為僅保留左側頁面（`clip-path: inset(0 50% 0 0)`），並自 負180度 繞中央書脊向右翻回 0度。50% 處可見，並攜帶 Z 軸微偏轉與 Y 軸抬升，如同書頁從左方翻回、落下覆蓋右側。

### 4. 三頁模式與滾動模式降級
- 為了避免在三欄（或更多欄）排版下進行 3D 旋轉產生視覺扭曲，當檢測到 `cols-3` 以上時，翻頁效果會自動降級為標準的滑動過渡，確保閱讀器在任何極端排版下均維持高可用性。

---
"""

with open(walkthrough_path, 'a', encoding='utf-8') as f:
    f.write(new_details)

print("Successfully appended realistic curl-flip documentation to walkthrough.md")
