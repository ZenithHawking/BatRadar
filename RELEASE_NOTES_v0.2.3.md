# BatRadar v0.2.3

User v0.2.2 đã có auto-update — chỉ cần khởi động app, nhận dialog "Có phiên bản mới" và bấm Cập nhật là xong.

## 🐛 Sửa lỗi quan trọng

- **Thông báo cảnh báo đã hoạt động trở lại**. Trước đây toggle `Notifications` và `Alert threshold` trong Settings không có tác dụng — hàm kiểm tra ngưỡng đã viết nhưng chưa được gọi. Giờ khi session vượt 80% / 95% / 100%, Windows toast sẽ fire đúng (mỗi window chỉ 1 lần).
- **Nút Disconnect giờ thực sự disconnect**. Trước đây bấm Disconnect xong polling vẫn đọc lại credentials và auto-reconnect sau vài giây. Giờ Disconnect sẽ tạm tắt provider khỏi vòng lặp polling, và trong Settings sẽ hiện nút **"Bật lại"** để khôi phục bất cứ lúc nào.
- Credentials gốc (`~/.claude/.credentials.json`, `~/.codex/auth.json`) **không bao giờ bị xóa** — Claude Code / Codex CLI của bạn không bị ảnh hưởng.

## ✨ Khác

- Dashboard và floating icon tự ẩn provider bị disabled cho đến khi bạn bật lại
- Status badge thêm trạng thái `⏸ Disabled` để phân biệt với "Not connected"

---

## Cài đặt

- **User v0.2.2:** App tự thông báo, bấm Cập nhật là xong.
- **User v0.2.1 (hoặc cũ hơn):** Tải `BatRadar Setup 0.2.3.exe` bên dưới, chạy đè 1 lần. Từ phiên bản này về sau sẽ tự cập nhật.
