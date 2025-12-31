import subprocess
import json
import re
import sys
import datetime
import time

# ================= 配置 =================
# chip-tool 的路径
CHIP_TOOL_PATH = "./chip-tool"
# =======================================

def strip_ansi(text):
    """去除 ANSI 颜色代码"""
    ansi_escape = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')
    return ansi_escape.sub('', text)

def run_command(cmd):
    try:
        # 合并 stdout 和 stderr，并且不检查返回码 (check=False)，因为 chip-tool 不带参数可能会返回错误码
        result = subprocess.run(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, check=False)
        return strip_ansi(result.stdout)
    except Exception as e:
        print(f"Error running command '{cmd}': {e}", file=sys.stderr)
        return ""

def parse_clusters(output):
    clusters = []
    seen = set()
    
    lines = output.splitlines()
    in_clusters_block = False
    
    for line in lines:
        line = line.strip()
        if not line: continue
        
        # 检测 Clusters 块的开始
        if "Clusters:" in line:
            in_clusters_block = True
            continue
            
        # 检测 Clusters 块的结束 (遇到下一个标题或空行)
        if in_clusters_block:
            if "Command sets:" in line or line.startswith('+--'):
                # 如果是分隔线，可能是开始也可能是结束，我们只关心它是否结束了列表
                # 但在这个格式中，列表被 +-- 包围，所以我们可以忽略分隔线
                if line.startswith('+--') and len(clusters) > 0:
                     # 如果已经收集了一些 clusters，再次遇到分隔线可能意味着结束
                     # 但为了保险，我们只在遇到 "Command sets:" 时停止，或者依靠正则过滤
                     pass
                if "Command sets:" in line:
                    in_clusters_block = False
                    break

            # 匹配格式: | * clustername |
            # 这里的正则：
            # \|?  : 可选的竖线
            # \s*  : 空格
            # \*   : 星号
            # \s*  : 空格
            # ([a-zA-Z0-9-]+) : 捕获组，Cluster 名称
            match = re.search(r'\|\s*\*\s*([a-zA-Z0-9-]+)', line)
            
            if match:
                name = match.group(1).lower()
                # 再次过滤，确保不是标题行
                if name in ['clusters', 'command sets']:
                    continue
                    
                if name not in seen:
                    seen.add(name)
                    clusters.append(name)
    
    return clusters

def to_display_name(name):
    return ''.join(word.capitalize() for word in name.split('-'))

def main():
    print(f"Using chip-tool at: {CHIP_TOOL_PATH}")
    print("Step 1: Fetching cluster list...")
    
    # 直接运行 chip-tool 获取列表
    output = run_command(f"{CHIP_TOOL_PATH}")
    
    if not output:
        print("Error: Failed to run chip-tool. Output is empty.")
        return

    # 打印前几行用于确认
    # print("-" * 20 + " Output Preview " + "-" * 20)
    # print(output[:500])
    # print("-" * 20)

    clusters = parse_clusters(output)
    clusters.sort()
    
    print(f"Found {len(clusters)} clusters.")
    
    if len(clusters) == 0:
        print("Error: No clusters found. Trying fallback method (using --help)...")
        # 备用：尝试 --help
        output = run_command(f"{CHIP_TOOL_PATH} --help")
        clusters = parse_clusters(output)
        clusters.sort()
        print(f"Found {len(clusters)} clusters with --help.")

    if len(clusters) == 0:
        print("Error: Still no clusters found. Please check the output format.")
        return

    result_data = {
        "cachedAt": datetime.datetime.now().isoformat(),
        "clusters": []
    }

    # 通用命令和属性过滤列表
    generic_cmds = ['read', 'write', 'subscribe', 'subscribe-event', 'commands', 'usage', 'help']
    generic_attrs = ['destination-id', 'endpoint-id-ignored-for-group-commands', 'help', 'min-interval', 'max-interval', 'fabric-filtered']

    total = len(clusters)
    for i, cluster in enumerate(clusters):
        print(f"[{i+1}/{total}] Processing '{cluster}'...")
        
        cluster_obj = {
            "name": cluster,
            "displayName": to_display_name(cluster),
            "attributes": [],
            "commands": [],
            "detailsLoaded": True
        }
        
        # 1. 获取 Commands
        # 注意：chip-tool clustername --help 也会输出类似表格
        cmd_out = run_command(f"{CHIP_TOOL_PATH} {cluster} --help")
        # 这里我们复用简单的正则，因为 command 列表格式类似
        # 但我们需要更宽容的解析，因为 command 输出可能没有 "Clusters:" 标题
        cmds = []
        for line in cmd_out.splitlines():
            match = re.search(r'\|\s*\*\s*([a-zA-Z0-9-]+)', line)
            if match:
                cmd_name = match.group(1).lower()
                if cmd_name not in generic_cmds and cmd_name != cluster: # 排除自身名字
                    cmds.append(cmd_name)
        
        # 去重
        cmds = sorted(list(set(cmds)))
        for c in cmds:
            cluster_obj["commands"].append({
                "name": c,
                "displayName": to_display_name(c)
            })
        
        # 2. 获取 Attributes (通过 read --help)
        attr_out = run_command(f"{CHIP_TOOL_PATH} {cluster} read --help")
        attrs = []
        for line in attr_out.splitlines():
            match = re.search(r'\|\s*\*\s*([a-zA-Z0-9-]+)', line)
            if match:
                attr_name = match.group(1).lower()
                if attr_name not in generic_attrs:
                    attrs.append(attr_name)
        
        # 去重
        attrs = sorted(list(set(attrs)))
        for a in attrs:
            cluster_obj["attributes"].append({
                "name": a,
                "displayName": to_display_name(a)
            })
        
        result_data["clusters"].append(cluster_obj)

    output_filename = "chiptool_clusters.json"
    with open(output_filename, "w") as f:
        json.dump(result_data, f, indent=2)
    
    print(f"\nSuccess! Generated {output_filename}")
    print(f"Total Clusters: {len(result_data['clusters'])}")
    print("Please copy this file to your project's 'resources' directory.")

if __name__ == "__main__":
    main()
