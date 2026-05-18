# BatRadar v0.2.2

## ⚠ Hành động 1 lần cho user đang dùng v0.2.1

Phiên bản này thêm khả năng **tự cập nhật**. Bạn cần tải `BatRadar Setup 0.2.2.exe` và chạy đè lên bản cũ **một lần duy nhất**. Cài đặt và dữ liệu (`%APPDATA%/batradar/`) được giữ nguyên.

Từ phiên bản này trở đi, BatRadar sẽ tự thông báo khi có bản mới — không cần thao tác thủ công nữa.

---

## ✨ Tính năng mới

- **Auto-update**: App tự kiểm tra phiên bản mới khi khởi động. Nếu có, hiện hộp thoại hỏi cập nhật — bạn quyết định tải hay để sau, không tải ngầm.
- **Nút "Kiểm tra" trong Settings**: Trigger check thủ công bất cứ lúc nào.
- **Floating icon thông minh hơn**:
  - Mặc định hiện `session %` (5 giờ)
  - Khi `weekly >= 90%` và cao hơn session, tự chuyển sang hiện weekly % kèm badge **"W"** đỏ để bạn biết
  - Không còn trường hợp icon hiện max ngẫu nhiên gây nhầm lẫn sau khi session reset

## 🐛 Sửa lỗi

- Nút **⊙ Icon** ở Dashboard giờ thực sự ẩn icon nổi. Trước đây sau khi ẩn, icon tự bật lại sau 1 giây (vì cơ chế khôi phục khi bị OS ẩn không phân biệt được hành động của user).
- Bỏ logic cũ của floating icon — không còn lấy `Math.max(session, weekly, weekly_opus)` gây hiện sai metric.

## 🔧 Kỹ thuật

- Thêm `electron-updater` (publish target: GitHub release của repo này)
- Workflow CI giờ upload thêm `latest.yml` để updater hoạt động

---

## Cài đặt

Tải `BatRadar Setup 0.2.2.exe` bên dưới và chạy.

**Yêu cầu:**
- Windows 10/11
- Claude Code hoặc Codex đã đăng nhập
