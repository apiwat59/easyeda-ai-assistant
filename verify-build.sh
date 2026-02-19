#!/bin/bash
echo "=== 验证编译结果 ==="
echo ""
echo "1. 检查 dist/index.js 文件大小和修改时间："
ls -lh dist/index.js
echo ""
echo "2. 检查新日志是否存在（应该看到 Unicode 编码的中文）："
grep -o "\\\\u91C7\\\\u96C6.*\\\\u5F00\\\\u59CB" dist/index.js | head -1
echo ""
echo "3. 检查逐页采集逻辑是否存在："
grep -c "开始逐页采集" src/review/collector.ts
echo ""
echo "4. dist 文件的 MD5 校验和："
md5sum dist/index.js
echo ""
echo "=== 请按以下步骤操作 ==="
echo "1. 在 EDA 中打开 扩展 → 扩展管理器"
echo "2. 找到 'AI 原理图助手' 扩展"
echo "3. 点击 '禁用' 按钮"
echo "4. 等待 2 秒"
echo "5. 点击 '启用' 按钮"
echo "6. 重新打开 AI 助手面板"
echo "7. 打开调试日志（Ctrl+D 或点击 🐛 按钮）"
echo "8. 应该能看到详细的采集日志"
