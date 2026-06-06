#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import json
import sys

# 读取源文件（新北市避難收容處所一覽表.geojson）
source_file = r"C:\Users\user\Downloads\mygeodata\新北市避難收容處所一覽表.geojson"
target_file = r"C:\Users\user\OneDrive\桌面\my-gis-project\public\xinzhuang_shelters.json"

# 打开并解析源文件，创建 Name -> contact_cellphone 映射
print("正在读取源文件...")
with open(source_file, 'r', encoding='utf-8') as f:
    source_data = json.load(f)

# 创建映射字典
name_to_phone = {}
for feature in source_data.get('features', []):
    props = feature.get('properties', {})
    name = props.get('Name')
    contact_phone = props.get('contact_cellphone')
    if name and contact_phone:
        name_to_phone[name] = contact_phone
        print(f"  {name}: {contact_phone}")

print(f"\n总共找到 {len(name_to_phone)} 条记录")

# 打开并解析目标文件
print("\n正在读取目标文件...")
with open(target_file, 'r', encoding='utf-8') as f:
    target_data = json.load(f)

# 更新目标文件中的 contact_ce 字段
updated_count = 0
not_found_count = 0

for feature in target_data.get('features', []):
    props = feature.get('properties', {})
    name = props.get('Name') or props.get('name2')
    
    if name in name_to_phone:
        old_value = props.get('contact_ce')
        new_value = name_to_phone[name]
        props['contact_ce'] = new_value
        updated_count += 1
        if old_value != new_value:
            print(f"  更新: {name} (从 {old_value} 改为 {new_value})")
    else:
        not_found_count += 1
        print(f"  ⚠️ 未找到匹配: {name}")

# 将更新后的数据写回目标文件
print(f"\n正在保存文件...")
with open(target_file, 'w', encoding='utf-8') as f:
    json.dump(target_data, f, ensure_ascii=False, indent=2)

print(f"\n✅ 更新完成!")
print(f"  成功更新: {updated_count} 条记录")
print(f"  未找到匹配: {not_found_count} 条记录")
