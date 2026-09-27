# 使用扩展缩减 provider 模型列表

`models.json` 对模型采用 upsert 语义，只能新增或更新条目，没有删除入口。扩展调用 `registerProvider` 并提供 `models` 时采用整份替换语义，因此由扩展接管 provider 的模型列表，才能按目录、授权清单与排除表真正缩减列表。
