# Giao diện theo mùa + phát hành Tauri 0.4.0 — Đặc tả

Ngày: 2026-10-07 · Nhánh: `seasonal-themes`

## 1. Mục tiêu

Giao diện BatRadar tự đổi theo dịp lễ (Halloween, Noel, Tết…) mà **không cần phát hành
bản cập nhật app cho mỗi mùa**. App chứa sẵn "khung" hiệu ứng; nội dung theme (màu, hình,
lịch) nằm trên GitHub, chủ repo đổi bằng `git push`.

Sự kiện đầu tiên: **Halloween, 2026-10-07 → 2026-10-31** (theo giờ máy người dùng).

Phát hành kèm: Tauri 0.4.0 thay cho Electron 0.3.0, người dùng Electron được chuyển
sang tự động.

### Thành công khi
- Người dùng Electron 0.3.0 (và 0.2.x) bấm cập nhật → máy chạy Tauri 0.4.0, bản Electron bị gỡ,
  settings/lịch sử/key OpenRouter còn nguyên, chỉ một mục tự khởi động.
- Từ 07/10 đến hết 31/10 dashboard + icon nổi hiện theme Halloween; 01/11 tự về giao diện
  thường mà không cần mở lại app.
- Sửa `themes/schedule.json` trên `main` → các máy đổi theo trong ≤ 6 giờ (hoặc khi mở lại app).
- Mất mạng vẫn hiện đúng theme đã tải; máy chưa từng có mạng dùng bản dự phòng đóng gói sẵn.
- Màu báo mức dùng (xanh/vàng/cam/đỏ) không bao giờ bị theme thay đổi.

### Ngoài phạm vi
- Hiệu ứng kiểu mới ngoài danh sách ở §4 (cần bản cập nhật app khi muốn thêm).
- Theme cho cửa sổ Settings.
- Nới rộng cửa sổ icon nổi (đồ trang trí phải nằm trong 62×62).
- Tự tính ngày âm lịch — ngày Tết ghi tay trong lịch.

## 2. Kiến trúc

Toàn bộ bộ máy theme chạy ở **phần giao diện (JS)** trong mỗi cửa sổ. Rust chỉ thêm
2 trường config và sự kiện `settings-changed`. Không nạp CSS/JS từ xa.

```
GitHub raw (main/themes/)                       App (mỗi cửa sổ)
  schedule.json  ─────── fetch ───────►  season/loader.js   tải + kiểm tra + cache
  <theme>/theme.json                     season/schedule.js chọn theme theo ngày
  <theme>/*.svg|png                      season/validate.js lọc dữ liệu theme
                                         season/apply.js    gắn màu + trang trí
                                         season/index.js    vòng đời, hẹn giờ
  src/themes/ (đóng gói sẵn) ── dự phòng khi chưa có cache ──┘
```

Base URL: `https://raw.githubusercontent.com/ZenithHawking/BatRadar/main/themes/`

### Vòng đời (`season/index.js`)
1. Khi trang mở: đọc config (`seasonal_theme`, `theme_preview`) qua `load_settings`.
2. Áp ngay theme từ cache (hoặc bản dự phòng) để không bị chớp giao diện thường.
3. Nếu lịch trong cache cũ hơn 6 giờ → tải lại lịch + theme đang/sắp chạy.
4. Mỗi 60 giây: chọn lại theme theo ngày; đổi thì gỡ trang trí cũ, gắn trang trí mới.
5. Nghe sự kiện `settings-changed` (Rust phát khi lưu settings) → áp lại ngay.

### Cache
- `localStorage`, dùng chung cho cả 3 cửa sổ (cùng origin):
  - `season:schedule` → `{ fetchedAt, entries }`
  - `season:theme:<id>` → theme đã kiểm tra, hình đã chuyển thành `data:` URL
- Giới hạn: mỗi hình ≤ 100 KB, mỗi theme ≤ 600 KB. Vượt giới hạn → bỏ theme đó.
- Lỗi mạng/HTTP → giữ cache cũ, thử lại ở chu kỳ sau. Không báo lỗi cho người dùng.
- Theme đã lưu không còn trong lịch → xoá khỏi cache khi tải lịch mới.

### Bản dự phòng
`src/themes/schedule.json` + `src/themes/halloween-bi-ngo/` — bản sao y hệt thư mục
`themes/` lúc phát hành. Dùng khi `localStorage` chưa có lịch.

## 3. Định dạng dữ liệu

### `themes/schedule.json`
```json
{
  "version": 1,
  "entries": [
    { "theme": "halloween-bi-ngo", "from": "2026-10-07", "to": "2026-10-31" }
  ]
}
```
- `from`, `to`: `YYYY-MM-DD`, tính cả hai đầu, theo giờ địa phương.
- Nhiều dòng khớp cùng ngày → **dòng đứng sau thắng**.
- `version` khác 1 → bỏ qua cả file (chừa chỗ đổi định dạng sau này).

### `themes/<id>/theme.json`
```json
{
  "id": "halloween-bi-ngo",
  "label": "Halloween",
  "colors": {
    "bg": "#0b0810", "card": "#140f1b", "border": "#2c2238",
    "accent": "#b388ff", "glow": "#ff8a1f"
  },
  "lantern": { "low": "#ff9628", "medium": "#ff9628", "high": "#ff7814", "critical": "#ef4444" },
  "mascot": {
    "low": "mascot-low.svg", "medium": "mascot-medium.svg",
    "high": "mascot-high.svg", "critical": "mascot-critical.svg",
    "sleepZ": true
  },
  "orbiter": "orbiter.svg",
  "header": { "badge": "badge.svg", "flyer": "flyer.svg", "moon": true },
  "particles": { "type": "rise", "color": "#ff8a1f" },
  "fog": "#a078dc"
}
```

### Quy tắc kiểm tra (`season/validate.js`)
| Trường | Hợp lệ khi | Không hợp lệ thì |
|---|---|---|
| `id` | khớp `^[a-z0-9-]{1,40}$` và trùng tên thư mục | bỏ cả theme |
| màu (mọi trường màu) | `^#[0-9a-fA-F]{6}$` | bỏ trường đó (dùng màu mặc định) |
| tên hình | khớp `^[a-z0-9-]+\.(svg\|png)$` (không `/`, không `..`) | bỏ trường đó |
| `particles.type` | `rise` \| `fall` \| `drift` | tắt hạt |
| `label` | chuỗi ≤ 24 ký tự, gắn bằng `textContent` | bỏ nhãn |
| trường lạ | — | bỏ qua |

Mọi trường đều tuỳ chọn trừ `id`. Theme thiếu `mascot` thì icon nổi giữ logo provider như thường.

## 4. Khung hiệu ứng (đóng gói trong app)

CSS nằm ở `src/css/season.css`. Màu theme đi vào biến CSS (`--season-*`) được gán từ JS sau khi
kiểm tra. Hình gắn bằng `<img src="data:…">` — script trong SVG không chạy trong `<img>`.

### Icon nổi
- **Linh vật** (bố cục center): hình 30px giữa trên; logo provider thu thành huy hiệu 15px
  bên phải; `%` ở dưới. Hiện hình theo class `low|medium|high|critical` mà `floating.js`
  đã đặt sẵn. `critical` thêm rung lắc. `sleepZ` hiện chữ "z" bay lên ở mức `low`.
- **Vật bay vòng**: 20px, quay quanh viền 9s/vòng, 4s/vòng ở `critical`.
- **Ánh đèn**: gradient tròn bên trong, màu theo `lantern.<mức>`, lập loè.
- Nền vòng tròn dùng `colors.bg`. **Viền và màu `%` không đổi.**
- Trang icon nổi **không bao giờ** được đổi nền `body` (cửa sổ rộng hơn vòng tròn → lộ khối tối).

### Dashboard
- `colors` → `--bg-primary`, `--bg-card`, `--border`, `--accent`.
- `header.badge` thay logo radar; `label` thành nhãn bên cạnh; tiêu đề tô gradient
  `glow` → `accent`.
- `header.flyer`: 3 bản bay ngang thanh tiêu đề ở tốc độ khác nhau, vỗ cánh.
- `header.moon`: trăng ló ở mép trên tiêu đề.
- `particles`: 9 hạt `rise` (lên), `fall` (xuống), `drift` (ngang), màu `particles.color`.
- `fog`: 2 lớp sương trôi ở đáy.
- Mọi trang trí `pointer-events: none`, nằm dưới nội dung thẻ.

### Chung
- `prefers-reduced-motion: reduce` → dừng mọi chuyển động, giữ hình tĩnh.
- Tắt theme → gỡ sạch phần tử `.season-*` và biến CSS, giao diện về như cũ.

## 5. Settings & config

Thêm vào `Config` (Rust, `src-tauri/src/config.rs`), có `serde(default)`:
- `seasonal_theme: bool` — mặc định `true`.
- `theme_preview: Option<String>` — không có UI; dev sửa tay `config.json` để ép hiện theme
  bất kỳ, bỏ qua lịch (vẫn tải theme đó từ GitHub/cache/dự phòng).

`save_settings` phát sự kiện `settings-changed` sau khi lưu.

Settings thêm một dòng sau "Notifications": **"Giao diện theo mùa"** — "Đổi giao diện theo dịp
lễ (Halloween, Noel, Tết…)" — toggle `toggle-seasonal`.

## 5b. Cập nhật app (Tauri updater)

Bản Electron tự kiểm tra cập nhật và hỏi người dùng; bản Tauri hiện chỉ có nút "Kiểm tra" cài
ngay không hỏi, không báo khi đã mới nhất. 0.4.0 phải bằng hoặc hơn Electron:

- Rust tự kiểm tra 30 giây sau khi mở app và mỗi 6 giờ (`updater.check()`), **không** tự cài.
- Có bản mới → thông báo Windows "BatRadar <ver> đã có" + phát sự kiện `update-available
  {version, notes}`; dashboard hiện dải trên cùng "Có bản <ver> — Cập nhật".
- Bấm "Cập nhật" (dashboard hoặc Settings) → command `install_update` tải + cài, phát
  `update-progress {percent}`; dải/nút hiện "Đang tải 45%…"; xong thì khởi động lại.
- Nút "Kiểm tra" trong Settings luôn có kết quả: "Đã là bản mới nhất (0.4.0)", "Có bản
  <ver>" (kèm nút Cập nhật), hoặc "Lỗi: <lý do>".
- Đang tải thì không cho bấm lần hai.

## 6. Sửa lỗi đi kèm

1. **Icon chìm sau cửa sổ khác** (`main.rs`, vòng 2 giây): khi icon không bị ẩn chủ động,
   luôn gọi lại `set_always_on_top(true)`, không chỉ khi `is_visible() == false`.
2. **Dashboard không cập nhật thẻ đổi trạng thái sau khi mở** (`dashboard.js`): khi nhận
   `usage-update` hoặc `provider-status-changed: connected` cho thẻ không có `#rows-<id>`,
   dựng lại thẻ đó (giữ vị trí và trạng thái mở rộng).
3. **Thông báo lặp Limit → Critical → Warning** (`check_alerts`): bắn mức cao thì đánh dấu
   luôn các mức thấp hơn.
4. **Mất settings khi ghi đè** (`config.rs`): ghi qua file tạm rồi rename; nếu file có nhưng
   parse lỗi thì dùng mặc định trong bộ nhớ, **không** ghi đè file.

## 7. Phát hành 0.4.0 & chuyển từ Electron

1. **Khoá ký mới**: `cargo tauri signer generate`; pubkey vào `tauri.conf.json`; khoá bí mật
   cất ngoài repo (chủ repo giữ). Build đặt `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)`.
2. **Version** 0.4.0 trong `Cargo.toml`, `tauri.conf.json`, `package.json`. Bỏ `"createUpdaterArtifacts": true` cũ nếu cần đổi sang `"v2Compatible"`/mặc định theo Tauri CLI 2.11.
3. **NSIS hook** (`src-tauri/windows/hooks.nsh`, khai báo ở `bundle.windows.nsis.installerHooks`):
   - `NSIS_HOOK_PREINSTALL`: nếu có
     `%LOCALAPPDATA%\Programs\bat-radar\Uninstall BatRadar.exe` → chạy với
     `/currentuser /S`, chờ xong; xoá giá trị Run `com.batradar.app` trong HKCU.
   - `NSIS_HOOK_POSTINSTALL`: nếu cài im lặng do updater Electron gọi (có tham số
     `--force-run`) → mở app sau khi cài.
4. **Release v0.4.0** trên GitHub gồm: `BatRadar_0.4.0_x64-setup.exe`, `.sig`, `latest.json`
   (updater Tauri), `latest.yml` (updater Electron, `version: 0.4.0`, trỏ tới cùng file
   `.exe`, `sha512` base64 + `size` của file đó).
5. **Đẩy `themes/` lên `main`** trước khi phát hành để app mới có lịch ngay.
6. **Gỡ Electron khỏi repo** (sau khi test chuyển đổi ở §8 đạt):
   - Xoá `main.js`, `preload.js`, `RELEASE_NOTES_v0.2.2.md`, `RELEASE_NOTES_v0.2.3.md`.
   - `package.json`: bỏ `electron`, `electron-builder`, `electron-updater`, khối `build`,
     `"main"`; scripts còn `dev` (`cargo tauri dev`), `build` (`cargo tauri build`),
     `test` (`node --test src/js/season/`). Tạo lại `package-lock.json`.
   - `src/js/utils.js`: bỏ nhánh `window.electronAPI`, chỉ còn Tauri.
   - Bỏ lệnh no-op `set_float_interactive` (chỉ để tương thích Electron) ở Rust và renderer.
   - `README.md`: bỏ badge Electron, bảng so sánh Electron/Tauri, cây thư mục cũ; hướng dẫn
     build bằng Tauri; ghi chú người dùng cũ được chuyển tự động.
   - Landing page: sửa chỗ nhắc Electron/dung lượng nếu có.
   - Release cũ trên GitHub **giữ nguyên** (lịch sử tải về). Code Electron vẫn còn trong
     git history nếu cần dựng bản "cầu nối" ở §9.

## 8. Kiểm thử

- **Test tự động** (`node --test`, không thêm thư viện): `schedule.js` (khớp ngày, hai đầu
  mút, trùng ngày → dòng sau thắng, `version` lạ, không có dòng khớp), `validate.js`
  (màu sai, tên hình có `../`, `particles.type` lạ, `id` không khớp thư mục, theme thiếu
  `id`). Chạy: `node --test src/js/season/`.
- **Kiểm tra giao diện**: render dashboard + icon nổi 4 mức bằng Chrome headless; chạy app
  thật với theme bật/tắt, chuyển ngày (qua `theme_preview` và chỉnh lịch thử).
- **Chuyển đổi Electron → Tauri** trên máy thật, trước khi đăng release công khai:
  cài lại Electron 0.3.0 → trỏ updater tới release thử (draft/pre-release) → cập nhật →
  kiểm tra: chỉ còn Tauri chạy, `Programs\bat-radar` đã gỡ, config còn nguyên, một mục Run.
- Dọn mục Run `BatRadar` đang trỏ tới `target\debug\batradar.exe` sau khi test xong.

## 9. Rủi ro

| Rủi ro | Xử lý |
|---|---|
| Updater Electron truyền tham số NSIS lạ, file cài Tauri không chạy im lặng | Test §8; nếu hỏng, phát hành Electron 0.3.1 "cầu nối" tự tải + chạy file cài Tauri |
| Mất khoá ký Tauri | Người dùng kẹt ở 0.4.0 — chủ repo phải lưu khoá ở 2 nơi |
| `raw.githubusercontent.com` bị chặn/chậm ở một số mạng | Cache + bản dự phòng; theme là phần phụ, app vẫn chạy bình thường |
| Repo bị chiếm, theme bị sửa độc | Chỉ nhận dữ liệu đã kiểm tra; hình qua `<img>`; không CSS/JS từ xa |
