# IoT Nexus 迁移快速参考卡

> 配合 `web-migration-sop.md` 使用

## 🎯 项目路径

| 项目 | 路径 |
|------|------|
| IoT Nexus (源) | `E:\iot-nexus-core` |
| QA Center 前端 | `F:\meross_test_task_management` |
| QA Center 后端 | `F:\meross_qa_center` |
| 此文档 | `E:\iot-nexus-core\docs\` |

## 📋 阶段检查清单

### Phase 1: 后端 Django App ⏱️ 3-5天
```bash
cd F:\meross_qa_center
python manage.py startapp iot_nexus
```
- [ ] models.py
- [ ] serializers.py
- [ ] views.py
- [ ] urls.py
- [ ] 注册到 settings.py
- [ ] 注册到主 urls.py

### Phase 2: 数据库迁移 ⏱️ 0.5天
```bash
python manage.py makemigrations iot_nexus
python manage.py migrate
```
- [ ] 迁移执行成功
- [ ] 表结构验证

### Phase 3: 前端 API 层 ⏱️ 1天
```
F:\meross_test_task_management\src\api\modules\iot-nexus.js
```
- [ ] 文件创建
- [ ] 接口测试

### Phase 4: 前端页面 ⏱️ 5-7天
```
F:\meross_test_task_management\src\views\iot-nexus\
├── audit/index.vue          ← P0
├── audit/project.vue        ← P0
├── devices/list.vue         ← P0
├── devices/detail.vue       ← P1
└── audit/test-result.vue    ← P1
```
- [ ] 路由配置
- [ ] 页面开发
- [ ] 组件开发

### Phase 5: 联调测试 ⏱️ 2-3天
- [ ] 功能测试
- [ ] Bug 修复

### Phase 6: 部署 ⏱️ 1天
- [ ] 后端部署
- [ ] 前端构建
- [ ] 验证

## 🔌 API 接口速查

```javascript
// 项目
GET    /api/iotnexus/projects/
POST   /api/iotnexus/projects/
GET    /api/iotnexus/projects/{id}/
PUT    /api/iotnexus/projects/{id}/
DELETE /api/iotnexus/projects/{id}/
POST   /api/iotnexus/projects/{id}/duplicate/

// 测试记录
GET    /api/iotnexus/test-runs/?project={id}
POST   /api/iotnexus/test-runs/
DELETE /api/iotnexus/test-runs/{id}/

// 设备
GET    /api/iotnexus/devices/
POST   /api/iotnexus/devices/
GET    /api/iotnexus/devices/{id}/info/
POST   /api/iotnexus/devices/{id}/check_online/

// 协议测试代理
POST   /api/iotnexus/proxy/execute/
```

## 📦 关键源文件映射

| Vue 组件 | React 源文件 |
|----------|-------------|
| audit/index.vue | ProtocolAudit.tsx (ProjectDashboard) |
| audit/project.vue | ProtocolAudit.tsx (主编辑区) |
| devices/list.vue | DeviceDiscoveryModal.tsx |
| devices/detail.vue | MatterDashboard.tsx |
| audit/test-result.vue | TestResultViewer.tsx |

## 🔧 常用命令

```bash
# 后端开发
cd F:\meross_qa_center
python manage.py runserver 0.0.0.0:8000

# 前端开发
cd F:\meross_test_task_management
npm run dev

# 数据库迁移
python manage.py makemigrations iot_nexus
python manage.py migrate

# 生产构建
npm run build:prod
```

## 🎨 Element UI 常用组件

```vue
<!-- 表格 -->
<el-table :data="list" v-loading="loading">
  <el-table-column prop="name" label="名称" />
</el-table>

<!-- 表单 -->
<el-form :model="form" label-width="100px">
  <el-form-item label="名称" required>
    <el-input v-model="form.name" />
  </el-form-item>
</el-form>

<!-- 弹窗 -->
<el-dialog title="标题" :visible.sync="dialogVisible">
  <!-- 内容 -->
</el-dialog>

<!-- 消息 -->
this.$message.success('操作成功')
this.$message.error('操作失败')
this.$confirm('确定删除?', '提示', { type: 'warning' })
```

## 💡 新对话引导语

在新对话中使用以下提示词：

```
我正在进行 IoT Nexus 迁移到 Meross QA Center 的开发工作。
请查看迁移方案文档：E:\iot-nexus-core\docs\web-migration-sop.md

当前进度：[Phase X]
需要完成的任务：[具体任务描述]

相关项目路径：
- IoT Nexus 源码：E:\iot-nexus-core
- QA Center 前端：F:\meross_test_task_management
- QA Center 后端：F:\meross_qa_center
```

---

*快速参考卡 v1.0 | 2026-02-04*
