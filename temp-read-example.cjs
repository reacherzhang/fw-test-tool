// 临时脚本：读取 matter.js 示例代码
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'node_modules/@matter/examples/dist/esm/controller/ControllerNode.js');
const content = fs.readFileSync(filePath, 'utf-8');

// 查找关键部分
const lines = content.split('\n');
console.log('=== ControllerNode.js 关键部分 ===');
console.log('Total lines:', lines.length);

// 查找 commission 相关代码
const commissionLines = [];
for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    if (line.includes('commission') || line.includes('pair') || line.includes('pase') || line.includes('wifi')) {
        commissionLines.push(`${i + 1}: ${lines[i]}`);
    }
}
console.log('\n=== Commission 相关代码 ===');
console.log(commissionLines.slice(0, 50).join('\n'));
