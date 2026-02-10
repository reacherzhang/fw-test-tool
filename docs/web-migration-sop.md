# IoT Nexus 迁移至 Meross QA Center 执行方案

> **文档版本**: v1.0  
> **创建日期**: 2026-02-04  
> **最后更新**: 2026-02-04  
> **状态**: 待执行

---

## 📋 项目概述

### 目标
将 IoT Nexus Core (Electron 桌面应用) 的核心功能迁移至 Meross QA Center (Web 应用)，作为独立模块嵌入现有测试管理系统。

### 优先迁移功能
1. **协议审计 (Audit)** - 协议管理、测试执行、结果查看
2. **设备列表及详情** - 已注册设备管理、设备信息查询

### 暂不迁移功能
- WiFi 扫描/连接 (需系统级 API)
- Matter 协议交互 (需 SSH + chip-tool)
- 本地 mDNS 设备发现 (浏览器不支持)
- 串口通信 (需桌面环境)

---

## 🔧 技术栈对照

| 层级 | 原项目 (IoT Nexus) | 目标项目 (QA Center) |
|------|-------------------|---------------------|
| **前端框架** | React 19 + TypeScript | Vue 2.6.10 + JavaScript |
| **UI 组件** | Lucide React + 自定义 | Element UI 2.13.2 |
| **状态管理** | React useState/useContext | Vuex 3.1.0 |
| **HTTP 客户端** | Electron IPC + fetch | Axios 0.18.1 |
| **后端** | Electron Main Process (Node.js) | Django 3.2.9 + DRF |
| **数据库** | MySQL (通过 IPC) | MySQL (直连) |

---

## 📁 项目路径

| 项目 | 路径 |
|------|------|
| IoT Nexus Core (源) | `E:\iot-nexus-core` |
| QA Center 前端 (目标) | `F:\meross_test_task_management` |
| QA Center 后端 (目标) | `F:\meross_qa_center` |

---

## 📊 分阶段执行计划

### 阶段总览

| 阶段 | 名称 | 预估时间 | 依赖 |
|------|------|---------|------|
| Phase 1 | 后端 Django App 开发 | 3-5 天 | 无 |
| Phase 2 | 数据库迁移 | 0.5 天 | Phase 1 |
| Phase 3 | 前端 API 层开发 | 1 天 | Phase 1 |
| Phase 4 | 前端核心页面开发 | 5-7 天 | Phase 3 |
| Phase 5 | 联调测试 | 2-3 天 | Phase 4 |
| Phase 6 | 部署上线 | 1 天 | Phase 5 |

**总计: 12-17 天**

---

# Phase 1: 后端 Django App 开发

## 1.1 创建 Django App

```bash
cd F:\meross_qa_center
python manage.py startapp iot_nexus
```

## 1.2 目录结构

```
F:\meross_qa_center\iot_nexus\
├── __init__.py
├── admin.py
├── apps.py
├── models.py          # 数据模型
├── serializers.py     # DRF 序列化器
├── views.py           # API 视图
├── urls.py            # 路由配置
├── migrations/        # 数据库迁移
└── services/          # 业务逻辑服务
    ├── __init__.py
    ├── device_proxy.py    # 设备 HTTP 代理
    └── mqtt_bridge.py     # MQTT 桥接 (复用 mock_testtool)
```

## 1.3 models.py 完整代码

```python
"""
IoT Nexus - 数据模型
"""
from django.db import models
import uuid

def generate_short_uuid():
    return str(uuid.uuid4())[:8]


class AuditProject(models.Model):
    """协议审计项目"""
    id = models.CharField(max_length=50, primary_key=True, default=generate_short_uuid)
    name = models.CharField(max_length=255, verbose_name="项目名称")
    description = models.TextField(blank=True, null=True, verbose_name="描述")
    status = models.CharField(
        max_length=20,
        choices=[('ACTIVE', '活跃'), ('ARCHIVED', '已归档')],
        default='ACTIVE'
    )
    device_config = models.JSONField(default=dict, blank=True, verbose_name="设备配置")
    # device_config 结构: {"ip": "192.168.1.100", "session": "xxx", "name": "设备名"}
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    
    # 关联创建者 (可选)
    creator = models.ForeignKey(
        'tester.Tester',
        on_delete=models.SET_NULL,
        null=True, blank=True,
        related_name='audit_projects'
    )

    class Meta:
        db_table = 'iot_audit_projects'
        ordering = ['-updated_at']
        verbose_name = "协议审计项目"
        verbose_name_plural = "协议审计项目"

    def __str__(self):
        return self.name


class Protocol(models.Model):
    """协议定义"""
    id = models.CharField(max_length=50, primary_key=True, default=generate_short_uuid)
    project = models.ForeignKey(
        AuditProject,
        on_delete=models.CASCADE,
        related_name='protocols'
    )
    namespace = models.CharField(max_length=255, verbose_name="协议命名空间")
    # 例如: Appliance.System.All, Appliance.Control.Toggle
    name = models.CharField(max_length=255, verbose_name="协议名称")
    description = models.TextField(blank=True, null=True)
    review_status = models.CharField(
        max_length=20,
        choices=[('UNVERIFIED', '未验证'), ('VERIFIED', '已验证')],
        default='UNVERIFIED'
    )
    methods = models.JSONField(default=dict, verbose_name="方法定义")
    # methods 结构示例:
    # {
    #   "GET": {
    #     "enabled": true,
    #     "payload": "{}",
    #     "schema": "{\"type\": \"object\", ...}",
    #     "lastResult": {...}
    #   },
    #   "SET": {...}
    # }
    tags = models.JSONField(default=list, blank=True)
    source_id = models.CharField(max_length=100, blank=True, null=True, verbose_name="来源ID")
    doc_url = models.URLField(blank=True, null=True, verbose_name="文档链接")

    class Meta:
        db_table = 'iot_protocols'
        ordering = ['namespace']
        verbose_name = "协议定义"
        verbose_name_plural = "协议定义"

    def __str__(self):
        return f"{self.namespace} - {self.name}"


class TestRun(models.Model):
    """测试执行记录"""
    id = models.CharField(max_length=50, primary_key=True, default=generate_short_uuid)
    project = models.ForeignKey(
        AuditProject,
        on_delete=models.CASCADE,
        related_name='test_runs'
    )
    start_time = models.DateTimeField(verbose_name="开始时间")
    end_time = models.DateTimeField(null=True, blank=True, verbose_name="结束时间")
    device_name = models.CharField(max_length=255, blank=True, null=True)
    device_ip = models.CharField(max_length=50, blank=True, null=True)
    status = models.CharField(
        max_length=20,
        choices=[('RUNNING', '运行中'), ('COMPLETED', '已完成'), ('FAILED', '失败')],
        default='COMPLETED'
    )
    summary = models.JSONField(default=dict, verbose_name="结果摘要")
    # summary 结构: {"total": 10, "passed": 8, "failed": 1, "timeout": 1}
    trigger_by = models.CharField(max_length=100, default='User')
    results = models.JSONField(default=list, verbose_name="详细结果")
    # results 结构: [
    #   {
    #     "protocolId": "xxx",
    #     "protocolName": "Appliance.System.All",
    #     "method": "GET",
    #     "status": "PASS",
    #     "duration": 123,
    #     "request": {...},
    #     "response": {...},
    #     "schemaErrors": []
    #   }
    # ]

    class Meta:
        db_table = 'iot_test_runs'
        ordering = ['-start_time']
        verbose_name = "测试记录"
        verbose_name_plural = "测试记录"


class RegisteredDevice(models.Model):
    """已注册设备 (用于网页版设备列表)"""
    id = models.CharField(max_length=50, primary_key=True, default=generate_short_uuid)
    name = models.CharField(max_length=255, verbose_name="设备名称")
    device_type = models.CharField(max_length=100, blank=True, null=True, verbose_name="设备类型")
    ip_address = models.CharField(max_length=50, verbose_name="IP地址")
    mac_address = models.CharField(max_length=50, blank=True, null=True)
    uuid = models.CharField(max_length=100, blank=True, null=True, verbose_name="设备UUID")
    firmware_version = models.CharField(max_length=50, blank=True, null=True)
    hardware_version = models.CharField(max_length=50, blank=True, null=True)
    last_seen = models.DateTimeField(auto_now=True)
    is_online = models.BooleanField(default=False)
    extra_info = models.JSONField(default=dict, blank=True, verbose_name="额外信息")
    # extra_info 可存储: system, hardware, firmware, digest 等完整信息

    class Meta:
        db_table = 'iot_registered_devices'
        ordering = ['-last_seen']
        verbose_name = "已注册设备"
        verbose_name_plural = "已注册设备"

    def __str__(self):
        return f"{self.name} ({self.ip_address})"
```

## 1.4 serializers.py 完整代码

```python
"""
IoT Nexus - DRF 序列化器
"""
from rest_framework import serializers
from .models import AuditProject, Protocol, TestRun, RegisteredDevice


class ProtocolSerializer(serializers.ModelSerializer):
    """协议序列化器"""
    class Meta:
        model = Protocol
        fields = [
            'id', 'namespace', 'name', 'description',
            'review_status', 'methods', 'tags', 'source_id', 'doc_url'
        ]


class AuditProjectListSerializer(serializers.ModelSerializer):
    """项目列表序列化器 (不含协议详情)"""
    protocol_count = serializers.SerializerMethodField()
    verified_count = serializers.SerializerMethodField()

    class Meta:
        model = AuditProject
        fields = [
            'id', 'name', 'description', 'status', 'device_config',
            'created_at', 'updated_at', 'protocol_count', 'verified_count'
        ]

    def get_protocol_count(self, obj):
        return obj.protocols.count()

    def get_verified_count(self, obj):
        return obj.protocols.filter(review_status='VERIFIED').count()


class AuditProjectDetailSerializer(serializers.ModelSerializer):
    """项目详情序列化器 (含协议)"""
    protocols = ProtocolSerializer(many=True, read_only=True)

    class Meta:
        model = AuditProject
        fields = [
            'id', 'name', 'description', 'status', 'device_config',
            'created_at', 'updated_at', 'protocols'
        ]


class AuditProjectWriteSerializer(serializers.ModelSerializer):
    """项目保存序列化器"""
    protocols = ProtocolSerializer(many=True, required=False)

    class Meta:
        model = AuditProject
        fields = ['id', 'name', 'description', 'status', 'device_config', 'protocols']

    def create(self, validated_data):
        protocols_data = validated_data.pop('protocols', [])
        project = AuditProject.objects.create(**validated_data)
        for protocol_data in protocols_data:
            Protocol.objects.create(project=project, **protocol_data)
        return project

    def update(self, instance, validated_data):
        protocols_data = validated_data.pop('protocols', None)

        # 更新项目基本信息
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()

        # 更新协议 (全量替换)
        if protocols_data is not None:
            instance.protocols.all().delete()
            for protocol_data in protocols_data:
                Protocol.objects.create(project=instance, **protocol_data)

        return instance


class TestRunSerializer(serializers.ModelSerializer):
    """测试记录序列化器"""
    project_name = serializers.CharField(source='project.name', read_only=True)

    class Meta:
        model = TestRun
        fields = [
            'id', 'project', 'project_name', 'start_time', 'end_time',
            'device_name', 'device_ip', 'status', 'summary', 'trigger_by', 'results'
        ]


class RegisteredDeviceSerializer(serializers.ModelSerializer):
    """已注册设备序列化器"""
    class Meta:
        model = RegisteredDevice
        fields = '__all__'
```

## 1.5 views.py 完整代码

```python
"""
IoT Nexus - API 视图
"""
from rest_framework import viewsets, status
from rest_framework.decorators import action, authentication_classes
from rest_framework.response import Response
from django.utils import timezone
import requests
import json

from tester.views import TokenAuthentication
from .models import AuditProject, Protocol, TestRun, RegisteredDevice
from .serializers import (
    AuditProjectListSerializer, AuditProjectDetailSerializer,
    AuditProjectWriteSerializer, ProtocolSerializer,
    TestRunSerializer, RegisteredDeviceSerializer
)


@authentication_classes([TokenAuthentication])
class AuditProjectViewSet(viewsets.ModelViewSet):
    """
    协议审计项目 API

    list:   GET    /api/iotnexus/projects/
    create: POST   /api/iotnexus/projects/
    read:   GET    /api/iotnexus/projects/{id}/
    update: PUT    /api/iotnexus/projects/{id}/
    delete: DELETE /api/iotnexus/projects/{id}/
    """
    queryset = AuditProject.objects.all()

    def get_serializer_class(self):
        if self.action == 'list':
            return AuditProjectListSerializer
        elif self.action in ['create', 'update', 'partial_update']:
            return AuditProjectWriteSerializer
        return AuditProjectDetailSerializer

    @action(detail=True, methods=['post'])
    def duplicate(self, request, pk=None):
        """复制项目 POST /api/iotnexus/projects/{id}/duplicate/"""
        project = self.get_object()
        new_project = AuditProject.objects.create(
            name=f"{project.name} (复制)",
            description=project.description,
            device_config=project.device_config,
        )
        for protocol in project.protocols.all():
            Protocol.objects.create(
                project=new_project,
                namespace=protocol.namespace,
                name=protocol.name,
                description=protocol.description,
                methods=protocol.methods,
                tags=protocol.tags,
            )
        return Response({
            'error_code': 0,
            'message': '复制成功',
            'data': AuditProjectDetailSerializer(new_project).data
        })


@authentication_classes([TokenAuthentication])
class ProtocolViewSet(viewsets.ModelViewSet):
    """
    协议 API (通常通过 Project 操作，此为独立操作入口)
    """
    queryset = Protocol.objects.all()
    serializer_class = ProtocolSerializer

    def get_queryset(self):
        queryset = super().get_queryset()
        project_id = self.request.query_params.get('project')
        if project_id:
            queryset = queryset.filter(project_id=project_id)
        return queryset


@authentication_classes([TokenAuthentication])
class TestRunViewSet(viewsets.ModelViewSet):
    """
    测试记录 API

    list:   GET    /api/iotnexus/test-runs/?project={id}
    create: POST   /api/iotnexus/test-runs/
    read:   GET    /api/iotnexus/test-runs/{id}/
    delete: DELETE /api/iotnexus/test-runs/{id}/
    """
    queryset = TestRun.objects.all()
    serializer_class = TestRunSerializer

    def get_queryset(self):
        queryset = super().get_queryset()
        project_id = self.request.query_params.get('project')
        if project_id:
            queryset = queryset.filter(project_id=project_id)
        return queryset[:100]

    def create(self, request, *args, **kwargs):
        """保存测试记录"""
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        self.perform_create(serializer)
        return Response({
            'error_code': 0,
            'message': '测试记录保存成功',
            'data': serializer.data
        })


@authentication_classes([TokenAuthentication])
class RegisteredDeviceViewSet(viewsets.ModelViewSet):
    """
    已注册设备 API
    """
    queryset = RegisteredDevice.objects.all()
    serializer_class = RegisteredDeviceSerializer

    @action(detail=True, methods=['get'])
    def info(self, request, pk=None):
        """
        获取设备详细信息 (通过 HTTP 代理)
        GET /api/iotnexus/devices/{id}/info/
        """
        device = self.get_object()
        try:
            result = self._get_device_system_all(device.ip_address)
            # 更新设备信息
            if result.get('payload'):
                payload = result['payload']
                all_data = payload.get('all', payload)
                device.is_online = True
                device.extra_info = all_data
                if all_data.get('system', {}).get('firmware'):
                    device.firmware_version = all_data['system']['firmware']
                if all_data.get('system', {}).get('hardware'):
                    device.hardware_version = all_data['system']['hardware']
                device.save()
            return Response({'error_code': 0, 'data': result})
        except Exception as e:
            device.is_online = False
            device.save()
            return Response({'error_code': 1, 'message': str(e)})

    @action(detail=True, methods=['post'])
    def check_online(self, request, pk=None):
        """
        检查设备在线状态
        POST /api/iotnexus/devices/{id}/check_online/
        """
        device = self.get_object()
        try:
            response = requests.get(
                f"http://{device.ip_address}/config",
                timeout=3,
                verify=False
            )
            is_online = response.status_code == 200
            device.is_online = is_online
            device.save()
            return Response({'error_code': 0, 'online': is_online})
        except:
            device.is_online = False
            device.save()
            return Response({'error_code': 0, 'online': False})

    def _get_device_system_all(self, ip):
        """获取设备 Appliance.System.All"""
        payload = {
            "header": {
                "messageId": f"web_{int(timezone.now().timestamp()*1000)}",
                "method": "GET",
                "namespace": "Appliance.System.All",
                "timestamp": int(timezone.now().timestamp()),
                "sign": "",
                "payloadVersion": 1
            },
            "payload": {}
        }
        response = requests.post(
            f"http://{ip}/config",
            json=payload,
            timeout=5,
            verify=False
        )
        return response.json()


@authentication_classes([TokenAuthentication])
class DeviceProxyViewSet(viewsets.ViewSet):
    """
    设备请求代理 - 用于执行协议测试
    解决浏览器 CORS 限制
    """

    @action(detail=False, methods=['post'])
    def execute(self, request):
        """
        代理执行设备请求

        POST /api/iotnexus/proxy/execute/
        {
            "target_ip": "192.168.1.100",
            "namespace": "Appliance.System.All",
            "method": "GET",
            "payload": {},
            "timeout": 5000
        }
        """
        target_ip = request.data.get('target_ip')
        namespace = request.data.get('namespace')
        method = request.data.get('method', 'GET')
        payload = request.data.get('payload', {})
        timeout = request.data.get('timeout', 5000) / 1000

        if not target_ip or not namespace:
            return Response({
                'error_code': 1,
                'message': 'Missing target_ip or namespace'
            }, status=400)

        try:
            # 构建 Meross 协议格式请求
            request_payload = {
                "header": {
                    "messageId": f"web_{int(timezone.now().timestamp()*1000)}",
                    "method": method,
                    "namespace": namespace,
                    "timestamp": int(timezone.now().timestamp()),
                    "sign": "",
                    "payloadVersion": 1
                },
                "payload": payload
            }

            start_time = timezone.now()
            response = requests.post(
                f"http://{target_ip}/config",
                json=request_payload,
                timeout=timeout,
                verify=False,
                headers={'Content-Type': 'application/json'}
            )
            duration = int((timezone.now() - start_time).total_seconds() * 1000)

            return Response({
                'error_code': 0,
                'success': True,
                'status': response.status_code,
                'data': response.json() if 'application/json' in response.headers.get('content-type', '') else response.text,
                'duration': duration
            })

        except requests.Timeout:
            return Response({
                'error_code': 1,
                'success': False,
                'message': 'Request timeout',
                'status': 'TIMEOUT'
            })
        except requests.RequestException as e:
            return Response({
                'error_code': 1,
                'success': False,
                'message': str(e),
                'status': 'ERROR'
            })
```

## 1.6 urls.py 完整代码

```python
"""
IoT Nexus - URL 路由配置
"""
from django.urls import path, include
from rest_framework.routers import DefaultRouter
from . import views

router = DefaultRouter()
router.register(r'projects', views.AuditProjectViewSet, basename='audit-project')
router.register(r'protocols', views.ProtocolViewSet, basename='protocol')
router.register(r'test-runs', views.TestRunViewSet, basename='test-run')
router.register(r'devices', views.RegisteredDeviceViewSet, basename='device')
router.register(r'proxy', views.DeviceProxyViewSet, basename='proxy')

urlpatterns = [
    path('', include(router.urls)),
]
```

## 1.7 注册到主项目

### settings.py
```python
INSTALLED_APPS = [
    # ... 其他 apps
    'iot_nexus',
]
```

### meross_qa_center/urls.py
```python
urlpatterns = [
    # ... 其他路由
    path('api/iotnexus/', include('iot_nexus.urls')),
]
```

## 1.8 完成标志
- [ ] Django App 创建完成
- [ ] Models 定义完成
- [ ] Serializers 定义完成
- [ ] Views 定义完成
- [ ] URLs 配置完成
- [ ] 注册到主项目

---

# Phase 2: 数据库迁移

## 2.1 执行迁移命令

```bash
cd F:\meross_qa_center
python manage.py makemigrations iot_nexus
python manage.py migrate
```

## 2.2 验证表创建

```sql
-- 验证表是否创建成功
SHOW TABLES LIKE 'iot_%';

-- 预期结果:
-- iot_audit_projects
-- iot_protocols
-- iot_test_runs
-- iot_registered_devices
```

## 2.3 (可选) 从 IoT Nexus 迁移现有数据

如果需要迁移 IoT Nexus 中现有的数据，可以：
1. 从 IoT Nexus 导出 localStorage 数据
2. 编写迁移脚本导入到新表

## 2.4 完成标志
- [ ] 迁移文件生成
- [ ] 数据库迁移执行成功
- [ ] 表结构验证通过

---

# Phase 3: 前端 API 层开发

## 3.1 创建 API 模块文件

**文件路径**: `F:\meross_test_task_management\src\api\modules\iot-nexus.js`

```javascript
/**
 * IoT Nexus API 模块
 * 协议审计、设备管理相关接口
 */
import request from '@/utils/request'

// ==================== 项目管理 ====================

/**
 * 获取项目列表
 */
export function getProjects() {
  return request({
    url: '/api/iotnexus/projects/',
    method: 'get'
  })
}

/**
 * 获取项目详情 (含协议)
 * @param {string} id 项目ID
 */
export function getProject(id) {
  return request({
    url: `/api/iotnexus/projects/${id}/`,
    method: 'get'
  })
}

/**
 * 保存项目 (新建或更新)
 * @param {Object} data 项目数据
 */
export function saveProject(data) {
  const method = data.id ? 'put' : 'post'
  const url = data.id
    ? `/api/iotnexus/projects/${data.id}/`
    : '/api/iotnexus/projects/'
  return request({ url, method, data })
}

/**
 * 删除项目
 * @param {string} id 项目ID
 */
export function deleteProject(id) {
  return request({
    url: `/api/iotnexus/projects/${id}/`,
    method: 'delete'
  })
}

/**
 * 复制项目
 * @param {string} id 项目ID
 */
export function duplicateProject(id) {
  return request({
    url: `/api/iotnexus/projects/${id}/duplicate/`,
    method: 'post'
  })
}

// ==================== 测试记录 ====================

/**
 * 获取测试记录列表
 * @param {string} projectId 项目ID (可选)
 */
export function getTestRuns(projectId) {
  return request({
    url: '/api/iotnexus/test-runs/',
    method: 'get',
    params: projectId ? { project: projectId } : {}
  })
}

/**
 * 获取测试记录详情
 * @param {string} id 记录ID
 */
export function getTestRun(id) {
  return request({
    url: `/api/iotnexus/test-runs/${id}/`,
    method: 'get'
  })
}

/**
 * 保存测试记录
 * @param {Object} data 测试记录数据
 */
export function saveTestRun(data) {
  return request({
    url: '/api/iotnexus/test-runs/',
    method: 'post',
    data
  })
}

/**
 * 删除测试记录
 * @param {string} id 记录ID
 */
export function deleteTestRun(id) {
  return request({
    url: `/api/iotnexus/test-runs/${id}/`,
    method: 'delete'
  })
}

// ==================== 设备管理 ====================

/**
 * 获取已注册设备列表
 */
export function getDevices() {
  return request({
    url: '/api/iotnexus/devices/',
    method: 'get'
  })
}

/**
 * 获取设备详情
 * @param {string} id 设备ID
 */
export function getDevice(id) {
  return request({
    url: `/api/iotnexus/devices/${id}/`,
    method: 'get'
  })
}

/**
 * 注册新设备
 * @param {Object} data 设备数据
 */
export function registerDevice(data) {
  return request({
    url: '/api/iotnexus/devices/',
    method: 'post',
    data
  })
}

/**
 * 更新设备信息
 * @param {string} id 设备ID
 * @param {Object} data 设备数据
 */
export function updateDevice(id, data) {
  return request({
    url: `/api/iotnexus/devices/${id}/`,
    method: 'put',
    data
  })
}

/**
 * 删除设备
 * @param {string} id 设备ID
 */
export function deleteDevice(id) {
  return request({
    url: `/api/iotnexus/devices/${id}/`,
    method: 'delete'
  })
}

/**
 * 获取设备实时信息 (Appliance.System.All)
 * @param {string} id 设备ID
 */
export function getDeviceInfo(id) {
  return request({
    url: `/api/iotnexus/devices/${id}/info/`,
    method: 'get'
  })
}

/**
 * 检查设备在线状态
 * @param {string} id 设备ID
 */
export function checkDeviceOnline(id) {
  return request({
    url: `/api/iotnexus/devices/${id}/check_online/`,
    method: 'post'
  })
}

// ==================== 协议测试代理 ====================

/**
 * 执行协议测试 (通过后端代理)
 * @param {Object} params 测试参数
 * @param {string} params.target_ip 目标设备IP
 * @param {string} params.namespace 协议命名空间
 * @param {string} params.method 请求方法 (GET/SET/PUSH/SYNC)
 * @param {Object} params.payload 请求载荷
 * @param {number} params.timeout 超时时间 (毫秒)
 */
export function executeTest(params) {
  return request({
    url: '/api/iotnexus/proxy/execute/',
    method: 'post',
    data: params,
    timeout: (params.timeout || 5000) + 2000 // 额外缓冲
  })
}

// ==================== 协议单独操作 (可选) ====================

/**
 * 获取项目下的协议列表
 * @param {string} projectId 项目ID
 */
export function getProtocols(projectId) {
  return request({
    url: '/api/iotnexus/protocols/',
    method: 'get',
    params: { project: projectId }
  })
}
```

## 3.2 完成标志
- [ ] API 模块文件创建完成
- [ ] 所有接口函数定义完成
- [ ] 测试接口可用性

---

# Phase 4: 前端核心页面开发

## 4.1 目录结构

```
F:\meross_test_task_management\src\views\iot-nexus\
├── audit/
│   ├── index.vue          # 项目列表页
│   ├── project.vue        # 项目详情/编辑页
│   └── test-result.vue    # 测试结果查看页
├── devices/
│   ├── list.vue           # 设备列表页
│   └── detail.vue         # 设备详情页
└── components/
    ├── ProtocolEditor.vue     # 协议编辑器
    ├── MethodTester.vue       # 方法测试面板
    ├── PayloadEditor.vue      # Payload 编辑器
    ├── SchemaValidator.vue    # Schema 验证器
    └── ResultViewer.vue       # 结果查看器
```

## 4.2 路由配置

**修改文件**: `F:\meross_test_task_management\src\router\index.js`

在 `constantRoutes` 数组中添加:

```javascript
{
  path: '/iot-nexus',
  name: 'iot-nexus',
  component: Layout,
  meta: { title: 'IoT协议审计', icon: 'el-icon-connection' },
  children: [
    {
      path: 'audit',
      name: 'iot-audit',
      component: () => import('@/views/iot-nexus/audit/index'),
      meta: { title: '协议审计' }
    },
    {
      path: 'audit/project/:id',
      name: 'iot-audit-project',
      component: () => import('@/views/iot-nexus/audit/project'),
      hidden: true,
      meta: { title: '项目详情' }
    },
    {
      path: 'audit/result/:id',
      name: 'iot-audit-result',
      component: () => import('@/views/iot-nexus/audit/test-result'),
      hidden: true,
      meta: { title: '测试结果' }
    },
    {
      path: 'devices',
      name: 'iot-devices',
      component: () => import('@/views/iot-nexus/devices/list'),
      meta: { title: '设备管理' }
    },
    {
      path: 'devices/:id',
      name: 'iot-device-detail',
      component: () => import('@/views/iot-nexus/devices/detail'),
      hidden: true,
      meta: { title: '设备详情' }
    }
  ]
},
```

## 4.3 待开发页面清单

| 序号 | 页面 | 优先级 | 参考源文件 | 预估时间 |
|------|------|--------|-----------|---------|
| 1 | audit/index.vue | P0 | ProtocolAudit.tsx (ProjectDashboard) | 1 天 |
| 2 | audit/project.vue | P0 | ProtocolAudit.tsx (主编辑区) | 2 天 |
| 3 | devices/list.vue | P0 | DeviceDiscoveryModal.tsx | 1 天 |
| 4 | devices/detail.vue | P1 | MatterDashboard.tsx | 1 天 |
| 5 | audit/test-result.vue | P1 | TestResultViewer.tsx | 1 天 |
| 6 | components/ProtocolEditor.vue | P0 | ProtocolAudit.tsx | 1 天 |
| 7 | components/MethodTester.vue | P0 | ProtocolAudit.tsx | 0.5 天 |
| 8 | components/PayloadEditor.vue | P0 | 自定义 JSON 编辑器 | 0.5 天 |

## 4.4 页面开发指南

### 样式规范
- 使用 Element UI 组件保持一致性
- 参考现有页面的布局风格 (如 test-tools/mock.vue)
- 响应式: 支持 1280px - 1920px 屏幕宽度

### 组件使用规范
- 表格: `el-table`
- 表单: `el-form` + `el-form-item`
- 弹窗: `el-dialog`
- 消息: `this.$message`
- 确认框: `this.$confirm`

### 数据流规范
- API 调用使用 `this.$https` 或直接 import
- 页面状态使用 data()
- 跨页面状态考虑使用 Vuex

## 4.5 完成标志
- [ ] 所有页面文件创建
- [ ] 路由配置完成
- [ ] 页面基础功能实现
- [ ] 页面样式完成

---

# Phase 5: 联调测试

## 5.1 测试环境准备

1. 确保后端服务运行
2. 确保前端开发服务运行
3. 准备测试设备 (可用的 Meross IoT 设备)

## 5.2 测试用例清单

### 项目管理
- [ ] 创建新项目
- [ ] 编辑项目名称和描述
- [ ] 删除项目
- [ ] 复制项目

### 协议管理
- [ ] 添加协议到项目
- [ ] 编辑协议 namespace/name
- [ ] 编辑 GET/SET 方法的 payload
- [ ] 删除协议

### 协议测试
- [ ] 执行单个协议 GET 测试
- [ ] 执行单个协议 SET 测试
- [ ] 批量执行测试
- [ ] 验证 Schema 校验功能
- [ ] 测试超时处理

### 设备管理
- [ ] 注册新设备
- [ ] 获取设备详细信息
- [ ] 检查设备在线状态
- [ ] 删除设备

### 测试记录
- [ ] 查看历史测试记录
- [ ] 查看测试详情
- [ ] 删除测试记录

## 5.3 性能测试
- [ ] 大量协议加载性能 (100+ 协议)
- [ ] 批量测试执行性能
- [ ] 设备响应超时处理

## 5.4 完成标志
- [ ] 所有功能测试通过
- [ ] 性能测试达标
- [ ] Bug 修复完成

---

# Phase 6: 部署上线

## 6.1 后端部署

```bash
# 1. 拉取最新代码
cd /path/to/meross_qa_center
git pull

# 2. 安装依赖 (如有新增)
pip install -r requirements.txt

# 3. 执行数据库迁移
python manage.py migrate

# 4. 收集静态文件
python manage.py collectstatic

# 5. 重启服务
sudo systemctl restart meross-qa-center
# 或
docker-compose restart
```

## 6.2 前端部署

```bash
# 1. 拉取最新代码
cd /path/to/meross_test_task_management
git pull

# 2. 安装依赖
npm install

# 3. 构建生产版本
npm run build:prod

# 4. 部署到 Nginx
cp -r dist/* /var/www/qa-center/
```

## 6.3 验证清单
- [ ] 后端 API 可访问
- [ ] 前端页面可访问
- [ ] 功能正常
- [ ] 无 Console 错误

## 6.4 完成标志
- [ ] 生产环境部署完成
- [ ] 功能验证通过
- [ ] 相关人员通知

---

# 📎 附录

## A. API 接口汇总

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/iotnexus/projects/` | 获取项目列表 |
| `POST` | `/api/iotnexus/projects/` | 创建项目 |
| `GET` | `/api/iotnexus/projects/{id}/` | 获取项目详情 |
| `PUT` | `/api/iotnexus/projects/{id}/` | 更新项目 |
| `DELETE` | `/api/iotnexus/projects/{id}/` | 删除项目 |
| `POST` | `/api/iotnexus/projects/{id}/duplicate/` | 复制项目 |
| `GET` | `/api/iotnexus/test-runs/` | 获取测试历史 |
| `POST` | `/api/iotnexus/test-runs/` | 保存测试结果 |
| `DELETE` | `/api/iotnexus/test-runs/{id}/` | 删除测试记录 |
| `GET` | `/api/iotnexus/devices/` | 获取设备列表 |
| `POST` | `/api/iotnexus/devices/` | 注册设备 |
| `GET` | `/api/iotnexus/devices/{id}/info/` | 获取设备详情 |
| `POST` | `/api/iotnexus/devices/{id}/check_online/` | 检查在线状态 |
| `POST` | `/api/iotnexus/proxy/execute/` | 代理执行协议测试 |

## B. 数据结构参考

### AuditProject
```json
{
  "id": "abc123",
  "name": "智能插座协议测试",
  "description": "MSS110 全协议测试",
  "status": "ACTIVE",
  "device_config": {
    "ip": "192.168.1.100",
    "session": "xxx",
    "name": "MSS110-Test"
  },
  "protocols": [...],
  "created_at": "2026-02-04T10:00:00Z",
  "updated_at": "2026-02-04T12:00:00Z"
}
```

### Protocol
```json
{
  "id": "proto123",
  "namespace": "Appliance.Control.Toggle",
  "name": "Toggle",
  "description": "开关控制",
  "review_status": "VERIFIED",
  "methods": {
    "GET": {
      "enabled": true,
      "payload": "{}",
      "schema": "{...}"
    },
    "SET": {
      "enabled": true,
      "payload": "{\"toggle\": {\"onoff\": 1}}",
      "schema": "{...}"
    }
  },
  "tags": ["control", "switch"]
}
```

### TestRun
```json
{
  "id": "run123",
  "project": "abc123",
  "start_time": "2026-02-04T10:00:00Z",
  "end_time": "2026-02-04T10:05:00Z",
  "device_name": "MSS110-Test",
  "device_ip": "192.168.1.100",
  "summary": {
    "total": 10,
    "passed": 8,
    "failed": 1,
    "timeout": 1
  },
  "results": [...]
}
```

## C. 源代码参考路径

| 功能 | IoT Nexus 源文件 |
|------|-----------------|
| 协议审计主组件 | `E:\iot-nexus-core\components\ProtocolAudit.tsx` |
| 测试结果查看 | `E:\iot-nexus-core\components\TestResultViewer.tsx` |
| 设备发现 | `E:\iot-nexus-core\components\DeviceDiscoveryModal.tsx` |
| Matter 设备管理 | `E:\iot-nexus-core\components\MatterDashboard.tsx` |
| 数据库服务 | `E:\iot-nexus-core\services\auditDatabaseService.ts` |
| 存储服务 | `E:\iot-nexus-core\services\auditStorageService.ts` |

---

# 📝 更新日志

| 日期 | 版本 | 更新内容 |
|------|------|---------|
| 2026-02-04 | v1.0 | 初始版本创建 |

---

*文档结束*
