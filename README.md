# HueLMS Sync Service

Worker này đăng nhập từng học viên vào HueLMS bằng **CCCD** và mật khẩu mặc định được cấu hình bằng biến môi trường, đọc bảng điểm/tiến độ rồi callback về Google Apps Script.

## Vì sao tách worker?
Google Apps Script không phù hợp với đăng nhập website cần cookie/JavaScript/trình duyệt. Worker dùng Playwright để thao tác giống trình duyệt thật. Mật khẩu HueLMS không xuất hiện trong frontend.

## Cài đặt
```bash
npm install
npx playwright install chromium
```
Tạo biến môi trường theo `.env.example` (không commit `.env`):
- `THEORY_SYNC_SECRET`: chuỗi bí mật giống Script Property bên Apps Script.
- `HUELMS_BASE_URL=https://vietmy.huelms.com`
- `HUELMS_DEFAULT_PASSWORD`: mật khẩu mặc định do trung tâm quản lý.

Chạy:
```bash
npm start
```

## Cấu hình Apps Script
Project Settings → Script Properties:
- `THEORY_SYNC_URL=https://domain-worker-cua-ban`
- `THEORY_SYNC_SECRET=<cùng secret với worker>`

Sau đó deploy Apps Script phiên bản mới.

## Lưu ý hiệu chỉnh lần đầu
HueLMS là website bên thứ ba và HTML có thể thay đổi. `server.js` dùng locator linh hoạt cho form đăng nhập và tìm link `/student/ep/`. Nếu tenant Việt Mỹ thay markup, cần hiệu chỉnh selector trong `login()` hoặc `openProgressPage()` một lần. Sau đó toàn bộ học viên chạy tự động.


## Chế độ bán tự động V5.4.3
- Không có cron/scheduler: worker chỉ chạy khi Admin bấm đồng bộ trên trang Học lý thuyết Online.
- Mỗi lượt tối đa 20 học viên.
- Xử lý tuần tự 1 tài khoản/lần, mặc định nghỉ 1.8 giây giữa hai học viên để giảm tải HueLMS.
- Có thể bấm `Đồng bộ` cho đúng 1 học viên để test trước.
- Trang quản trị hiển thị tiến độ job (đã xử lý / tổng / số lỗi).
- Endpoint trạng thái `/jobs/:id` yêu cầu `X-Theory-Secret`, không public trạng thái job.

Khuyến nghị triển khai: test 1 học viên trước, sau đó 5 học viên, rồi mới tăng tối đa 20 học viên/lượt.
