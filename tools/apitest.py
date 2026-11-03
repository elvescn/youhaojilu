import json, urllib.request, urllib.error, os

os.environ["NO_PROXY"] = "127.0.0.1,localhost"
os.environ["no_proxy"] = "127.0.0.1,localhost"

B = "http://127.0.0.1:8787"
TOKEN = "dev-token-2026"
H = {"authorization": "Bearer " + TOKEN, "content-type": "application/json"}

def call(method, path, body=None, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(B + path, data=data, method=method, headers=H)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            b = r.read()
            return r.status, (b if raw else json.loads(b))
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

def call_no_auth(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(B + path, data=data, method=method, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

results = []
def check(name, cond, detail=""):
    results.append(cond)
    print(("PASS " if cond else "FAIL ") + name + (("  -> " + detail) if detail else ""))

# 1) 错误口令
s, _ = call_no_auth("POST", "/api/login", {"token": "bad"})
check("错误口令登录返回401", s == 401, "status=%s" % s)

# 2) 正确口令
s, j = call_no_auth("POST", "/api/login", {"token": TOKEN})
check("正确口令登录返回200", s == 200 and j.get("ok"), "status=%s" % s)

# 3) 无 token 访问受保护接口
s, _ = call_no_auth("GET", "/api/fuel")
check("无token访问受保护接口401", s == 401, "status=%s" % s)

# 4) bootstrap
s, j = call("GET", "/api/bootstrap")
check("bootstrap含133油耗", s == 200 and j["summary"]["fuel_count"] == 133, "fuel_count=%s" % (j.get("summary",{}).get("fuel_count")))

# 5) 列表第一页
s, j = call("GET", "/api/fuel?page=1&size=10")
check("fuel列表返回10条", s == 200 and len(j["rows"]) == 10, "len=%s" % (len(j["rows"]) if s==200 else 0))

# 6) 油耗重算：在末尾追加一条加满记录，验证上一条加满(P)显示段油耗
s, j = call("GET", "/api/fuel?page=1&size=1")
last = j["rows"][0]
P_ID = last["id"]; P_ODO = last["odometer"]; C0 = last["consumption"]
print("末尾加满记录 id=%s odo=%s 原consumption=%s" % (P_ID, P_ODO, C0))
new_rec = {"filled_at": "2099-01-01T12:00:00", "odometer": P_ODO + 500, "liters": 40.0,
           "unit_price": 7.0, "is_full": True}
s, j = call("POST", "/api/fuel", new_rec)
check("新增加油记录成功", s == 200 and j.get("ok"), "status=%s" % s)
NEW_ID = j["id"] if s == 200 else None
# 重新取 P 记录
s, j = call("GET", "/api/fuel?page=1&size=1")
# 注意 size=1 排序 desc，最新是 NEW 记录；需要按 id 取 P
s, j = call("GET", "/api/fuel?size=500")
prow = next((r for r in j["rows"] if r["id"] == P_ID), None)
check("新增后上一条加满(P)油耗重算=8.00", prow is not None and prow["consumption"] == 8.0, "P.consumption=%s" % (prow["consumption"] if prow else None))
check("新增的F记录油耗为NULL", s == 200 and any(r["id"]==NEW_ID and r["consumption"] is None for r in j["rows"]), "")

# 7) 编辑新记录 -> 段里程变 250 -> 段油耗=16.00 落在 P
s, j = call("PUT", "/api/fuel/%d" % NEW_ID, {**new_rec, "odometer": P_ODO + 250})
check("编辑成功", s == 200, "status=%s" % s)
s, j = call("GET", "/api/fuel?size=500")
prow = next((r for r in j["rows"] if r["id"] == P_ID), None)
check("编辑后P油耗重算=16.00", prow is not None and prow["consumption"] == 16.0, "P.consumption=%s" % (prow["consumption"] if prow else None))

# 8) 删除新记录 -> P 应恢复为原值 C0（末尾加满无后继 -> NULL）
s, j = call("DELETE", "/api/fuel/%d" % NEW_ID)
check("删除记录成功", s == 200 and j.get("ok"), "status=%s" % s)
s, j = call("GET", "/api/fuel?size=500")
prow = next((r for r in j["rows"] if r["id"] == P_ID), None)
check("删除后P油耗恢复为原值%s" % C0, prow is not None and prow["consumption"] == C0, "P.consumption=%s" % (prow["consumption"] if prow else None))

# 9) 统计接口
s, j = call("GET", "/api/stats")
check("stats返回monthly数组非空", s == 200 and isinstance(j.get("monthly"), dict) and len(j["monthly"].get("fuel",[])) > 0, "fuel_months=%s" % (len(j.get("monthly",{}).get("fuel",[])) if s==200 else 0))

# 10) CSV 导出（含 BOM，用 in 判断）
s, raw = call("GET", "/api/export?format=csv&type=fuel", raw=True)
csv_text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
check("CSV导出含表头(含BOM)", s == 200 and "日期时间" in csv_text and "油耗" in csv_text, "head=%s" % csv_text[:24].replace("\ufeff","<BOM>"))

# 11) JSON 导出
s, raw = call("GET", "/api/export?format=json", raw=True)
jb = json.loads(raw.decode("utf-8")) if isinstance(raw, bytes) else raw
check("JSON导出含fuel数组=133", isinstance(jb, dict) and len(jb.get("fuel",[])) == 133, "fuel_len=%s" % len(jb.get("fuel",[])) if isinstance(jb,dict) else "n/a")

# 12) 导入（追加一条费用）
imp = {"expense": [{"occurred_at": "2099-02-02T08:00:00", "category": "配件费", "amount": 12.0, "note": "测试导入"}]}
s, j = call("POST", "/api/import", imp)
check("导入费用成功", s == 200 and j.get("imported",{}).get("nExp") == 1, "resp=%s" % j.get("imported"))

# 13) 删除导入的费用（回滚）
s, j = call("GET", "/api/expense?page=1&size=500")
test_exp = [r for r in j["rows"] if r["note"] == "测试导入"]
if test_exp:
    s, j = call("DELETE", "/api/expense/%d" % test_exp[0]["id"])
    check("删除导入费用成功", s == 200, "status=%s" % s)

# 14) 页面可访问（根节点 id=app-view）
s, raw = call("GET", "/", raw=True)
html = raw.decode("utf-8","replace") if isinstance(raw,bytes) else raw
check("首页HTML含app-view根与登录框", s == 200 and 'id="app-view"' in html and 'id="login-view"' in html, "len=%s" % len(html))

# 15) 静态资源 app.js / style.css / manifest
for pf in ["/app.js", "/style.css", "/manifest.webmanifest", "/icon.svg"]:
    s, _ = call("GET", pf, raw=True)
    check("静态资源可访问 %s" % pf, s == 200, "status=%s" % s)

print("\n==== 汇总 ====")
print("通过 %d / %d" % (sum(1 for x in results if x), len(results)))
