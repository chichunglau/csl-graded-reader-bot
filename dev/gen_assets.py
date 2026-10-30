import json, pathlib, sys
src = pathlib.Path("/mnt/skills/plugins/taiwan-huayu-materials/assets")
out = pathlib.Path(sys.argv[1])
def body(name):
    lines = [l for l in (src / name).read_text(encoding="utf-8").splitlines() if l.strip() and not l.startswith("#")]
    return "\n".join(lines)
assets = {
    "cnTwTerms": body("cn_tw_terms.tsv"),
    "variants": body("variants.tsv"),
    "sharedChars": body("shared_chars.txt"),
    "t2s": body("t2s_chars.tsv"),
}
js = ["/**",
      " * Assets.gs — 內建字形與用語對照（取自 taiwan-huayu-materials 技能 assets，可在試算表「用語對照」分頁增補）",
      " * cnTwTerms：大陸用語\\t臺灣常用\\t備註；variants：非標準字形\\t標準字形\\t備註；",
      " * sharedChars：臺灣也通用的簡化字（偵測簡體時不標記）；t2s：正體\\t簡體（多個以 | 分隔）。",
      " * 此檔由 dev/gen_assets.py 產生。",
      " */",
      "var GR_ASSETS = " + json.dumps(assets, ensure_ascii=False, indent=2) + ";", ""]
out.write_text("\n".join(js), encoding="utf-8")
print({k: v.count("\n") + 1 for k, v in assets.items()})
