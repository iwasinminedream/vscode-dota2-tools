# 行为树编辑器 - 快速开始

## 创建新的行为树

1. 创建一个新文件,命名为 `xxx.tree`
2. 输入基本结构:

```
"BehaviorTree"
{
    "Type"      "Root"
    "Name"      "我的行为树"
}
```

3. 双击打开文件,会自动使用可视化编辑器
4. 双击根节点,点击"添加节点"开始构建行为树

## 常见场景

### 简单的巡逻行为

```
"PatrolBehavior"
{
    "Type"          "Root"
    "Name"          "巡逻行为"
    "Children"
    {
        "PatrolSequence"
        {
            "Type"          "Sequence"
            "Name"          "巡逻序列"
            "Children"
            {
                "FindPatrolPoint"
                {
                    "Type"          "Action"
                    "Name"          "寻找巡逻点"
                }
                "MoveTo"
                {
                    "Type"          "Action"
                    "Name"          "移动到目标"
                }
                "Wait"
                {
                    "Type"          "Action"
                    "Name"          "等待"
                    "WaitTime"      "2"
                }
            }
        }
    }
}
```

### 战斗行为

```
"CombatBehavior"
{
    "Type"          "Root"
    "Name"          "战斗行为"
    "Children"
    {
        "CombatSelector"
        {
            "Type"          "Selector"
            "Name"          "战斗选择器"
            "Children"
            {
                "FleeSequence"
                {
                    "Type"          "Sequence"
                    "Name"          "逃跑序列"
                    "Children"
                    {
                        "CheckLowHealth"
                        {
                            "Type"          "Condition"
                            "Name"          "检查低血量"
                            "Threshold"     "20"
                        }
                        "Flee"
                        {
                            "Type"          "Action"
                            "Name"          "逃跑"
                        }
                    }
                }
                "AttackSequence"
                {
                    "Type"          "Sequence"
                    "Name"          "攻击序列"
                    "Children"
                    {
                        "HasTarget"
                        {
                            "Type"          "Condition"
                            "Name"          "有目标"
                        }
                        "Attack"
                        {
                            "Type"          "Action"
                            "Name"          "攻击"
                        }
                    }
                }
            }
        }
    }
}
```

## 提示和技巧

### 1. 节点命名规范

- 使用有意义的英文或拼音名称作为键名
- 中文说明放在 `Name` 字段
- 示例: `"CheckHealth"` -> `"Name" "检查生命值"`

### 2. 自定义属性

可以为节点添加任意自定义属性:

```
"WaitAction"
{
    "Type"          "Action"
    "Name"          "等待"
    "WaitTime"      "5"          // 自定义属性
    "CanInterrupt"  "true"       // 自定义属性
}
```

### 3. 保存位置信息

编辑器会自动保存节点的 `X` 和 `Y` 坐标,下次打开时会保持布局:

```
"MyNode"
{
    "Type"  "Action"
    "Name"  "我的节点"
    "X"     "250.5"
    "Y"     "180.0"
}
```

### 4. 键盘快捷键

- `Ctrl+S`: 快速保存
- `Delete`: 删除选中节点
- 双击: 选中节点并显示属性

### 5. 视图导航

- 拖动空白区域: 平移画布
- 鼠标滚轮: 缩放视图
- "适应"按钮: 重置视图并自动布局

## 与 Dota 2 Lua 集成

行为树通常需要配合 Lua 代码使用:

```lua
-- 加载行为树
function LoadBehaviorTree(unit, treePath)
    local treeData = LoadKeyValues(treePath)
    if treeData then
        -- 解析并执行行为树
        ExecuteBehaviorTree(unit, treeData)
    end
end

-- 示例用法
local hero = Entities:FindByName(nil, "npc_hero")
LoadBehaviorTree(hero, "scripts/behaviors/patrol.tree")
```

## 常见问题

**Q: 为什么双击文件没有打开可视化编辑器?**

A: 确保文件扩展名是 `.tree`,如果是其他扩展名,需要右键选择"打开方式"。

**Q: 如何查看原始 KV 代码?**

A: 右键点击文件,选择"Open With..." > "Text Editor"。

**Q: 节点太多,画布显示不全怎么办?**

A: 点击工具栏的"适应"按钮,或使用鼠标滚轮缩小视图。

**Q: 可以导出为其他格式吗?**

A: 目前只支持 `.tree` (KV) 格式,这是 Dota 2 原生支持的格式。

**Q: 如何备份我的行为树?**

A: 建议使用 Git 等版本控制系统,或定期复制 `.tree` 文件到其他位置。
