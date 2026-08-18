# dsh-safety

[English](README.md) | 涓枃

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License">
  &nbsp;
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square" alt="Dependencies">
  &nbsp;
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square" alt="Node">
  &nbsp;
  <img src="https://img.shields.io/badge/version-0.1.0-blue?style=flat-square" alt="v0.1.0">
  &nbsp;
  <img src="https://img.shields.io/github/actions/workflow/status/sugarxl/dsh-safety/test.yml?style=flat-square&label=CI" alt="CI">
</p>

<p align="center">
  <strong>DSH 瀹夊叏鍏滃簳锛氭嫤鎴棤鑴戝垹鏂囦欢 路 鍒犻櫎鍙挙閿€ 路 缁勫悎鍙洖婊?路 閲嶅惎鍓嶄綋妫€</strong><br>
  <em>plugin guard 路 safe_delete 路 snapshots 路 pre-restart check 路 standalone CLI</em>
</p>

<div align="center">

[鏄粈涔圿(#鏄粈涔? 路 [鍔熻兘](#鍔熻兘) 路 [瀹夎](#瀹夎) 路 [蹇€熶笂鎵媇(#蹇€熶笂鎵? 路 [CLI](#cli-鍙傝€? 路 [閰嶇疆](#閰嶇疆) 路 [璁捐](docs/DESIGN.md) 路 [甯歌闂](docs/FAQ.md) 路 [宸茬煡闄愬埗](docs/KNOWN-LIMITATIONS.md)

</div>

## 鏄粈涔?
**DeepSeek Harness (DSH) 鐨勫畨鍏ㄥ厹搴曟彃浠躲€?* 鎷︽埅 AI 浠ｇ悊鍒犻櫎/鏀瑰啓浼氳 DSH 鎵撲笉寮€鐨勫叧閿枃浠讹紱璁╂瘡涓€娆″垹闄ら兘鍙仮澶嶏紱鎶婃暣濂楁彃浠剁粍鍚堝揩鐓т笅鏉ャ€佷竴鏉″懡浠ゅ洖婊氾紱閲嶅惎鍓嶅厛浣撴銆?
闆剁涓夋柟渚濊禆銆傛棦鍙互浣滀负 DSH profile bundle 鎻掍欢瀹夎锛?*涔熷彲浠ヤ綔涓虹嫭绔?CLI 浣跨敤**鈥斺€斿嵆浣?DSH 宕╀簡锛屽畨鍏ㄧ綉渚濈劧鍙敤銆?
> 涓轰粈涔堝瓨鍦細涓€娆＄湡瀹炰簨鏁呪€斺€旇剼鏈洜 PowerShell `$HOME` 鏄彧璇诲彉閲忚€岄潤榛樿В鏋愰敊璺緞锛宍Remove-Item -Recurse -Force` 鍒犳帀浜嗕竴鏁翠釜寮曟搸杩愯鏍圭洰褰曘€傞偅娆¤兘鎭㈠绾睘杩愭皵锛堣鍒犵殑鏄?*鍙啀鐢熸垚**鐨勭敓鎴愮墿锛夛紱**鎵嬪啓鍐呭涓€鏃﹁鍒犲氨姘歌繙娌′簡**銆俤sh-safety 鎶婅繖娆′簨鏁呯殑鏁欒缂栫爜鎴愬己鍒舵満鍒讹紝鑰屼笉鏄竴鍙?娉ㄦ剰瀹夊叏"銆?
## 鍔熻兘

- **鎵ц鍓嶅畧鍗?*锛坄ctx.tools.guard`锛夛細鍦ㄥ伐鍏风湡姝ｈ繍琛?*涔嬪墠**鎷掔粷鐮村潖鎬ц皟鐢ㄣ€?  - **閫掑綊鍒犻櫎鐩綍鍦ㄤ换鎰忚矾寰勪竴寰嬫嫆缁?*锛坄rm -r/-rf`銆乣Remove-Item -Recurse`銆乣rd /s`銆乣rmdir`銆乣shutil.rmtree`銆乣fs.rm recursive`銆乣require('fs').rmSync`鈥︼級鈥斺€斾笉绠″垹鍝噷锛岄兘寮哄埗璧?`safe_delete`銆?  - `write`/`edit`/`str_replace_editor` 鍐?**protected** 鍖猴紙profile 鐨?`package.json`銆乣cordis.patch.yml`銆乣cordis.yml`銆乴ockfile銆乣node_modules`銆侀儴缃插畨瑁呯洰褰曘€乭ome 绾цˉ涓?璁剧疆锛夆啋 鎷掔粷銆?  - 鍒犻櫎鍛戒腑 **confirm** 鍖猴紙鏁翠釜 OS 鐢ㄦ埛涓荤洰褰曘€佹彃浠舵簮鐮併€乤gent-preset锛夆啋 鎷掔粷骞跺紩瀵艰蛋 `safe_delete`銆?  - **`run_code` 浠ｇ爜浣撳悓鏍疯鎵弿**鈥斺€斾换鎰忎唬鐮佹墽琛屼笉鑳介潬"缁曡繃宸ュ叿杈圭晫"鎶婂鍙椾繚鎶ゅ尯鐨?`fs.rmSync`/`shutil.rmtree` 钘忚捣鏉ャ€?  - **鍙橀噺寮曠敤鍒犻櫎涔熻兘鎷?*鈥斺€擿Remove-Item "$env:USERPROFILE\.dsh\鈥?` 杩欑灞曞紑鍚庢墠鏄湡瀹炶矾寰勭殑鍛戒护锛屼細鎶婂紩鐢?灏炬涓庝繚鎶ゆ爣璁版瘮瀵瑰苟鎷掔粷銆?- **`safe_delete`** 鈥斺€?鍞竴鍚堟硶鐨勫垹闄ら€氶亾銆傚垹闄?绉诲姩杩涘洖鏀剁珯锛坄safety_undo` 鍙繕鍘燂級锛沗preview:true` 鍏堢湅鍐嶅垹锛涙嫆缁濇枃浠剁郴缁熸牴鍜岃嚜韬姸鎬佺洰褰曪紱姣忔鍒犻櫎閮借繘瀹¤鏃ュ織銆?- **缁勫悎蹇収** 鈥斺€?`safety_snapshot` 鎶婃暣濂楁彃浠剁粍鍚堬紙姣忎釜 profile 鐨?manifest/琛ヤ竵/lockfile銆佹彃浠?`package.json`+`cordis.patch.yml`銆乤gent-preset锛夊甫 SHA-256 瀛樿捣鏉ワ紱`safety_restore` 涓€閿洖婊氬埌 last-known-good锛堢幇琛屾枃浠跺厛鑷姩澶囦唤锛夈€傞粯璁ゆ帓闄ゅ惈鍑嵁鐨勬枃浠躲€?- **閲嶅惎鍓嶄綋妫€** 鈥斺€?`safety_check` 妫€鏌?UTF-8銆?*涔辩爜妫€娴?*锛堥敊璇紪鐮佸線杩旓紝灏辨槸"DSH 鎵撲笉寮€"鐨勭粡鍏稿師鍥狅級銆丣SON 鍙В鏋愩€?*璺ㄨˉ涓佸眰閲嶅鎻掍欢琛?id**锛?涓€琛屽彧鑳藉湪涓€涓眰"瑙勫垯锛夈€?- **瀹¤鏃ュ織 + 缃戦〉闈㈡澘** 鈥斺€?鎷︽埅/鍒犻櫎/蹇収/鍥炴粴鍏ㄩ儴鐣欑棔锛涜缃〉鏂板銆屽畨鍏ㄤ腑蹇冦€嶅垎鍖猴紝鍙鍖栧洖鏀剁珯/蹇収/鏃ュ織锛屽彲涓€閿繕鍘?鍥炴粴銆?- **鐙珛 CLI** 鈥斺€?`dsh-safety` 涓嶄緷璧?DSH锛氬湪浣犺嚜宸辩粓绔氨鑳?delete/undo/snapshot/restore/check锛孌SH 鎵撲笉寮€鏃朵篃鑳界敤銆?
## 瀹夎

绯荤粺瑕佹眰锛氬凡瑁呭ソ DeepSeek Harness锛坄dsh web` 鑳藉惎鍔級銆俷pm 瀹夎鏃犻澶栬姹傦紱浠庝粨搴撳畨瑁呴渶瑕?Node.js >= 22 涓?pnpm銆?
### 浠?npm 瀹夎锛堟帹鑽愶級

```sh
dsh plugin --profile web add @suagr_xl/dsh-safety
```

`dsh plugin` 浼氳窇 pnpm锛屽苟鍥犳湰鍖呭０鏄庝簡 `dsh.bundle` 鑷姩鎶婂畠鍔犺繘 `dsh.profile.bundles`銆傝瀹岄噸鍚?`dsh web`锛屽畧鍗嵆鐢熸晥銆乣safety_*` 宸ュ叿鍙敤銆?
> 灏氭湭鍙戝竷鍒?npm鈥斺€斿湪姝や箣鍓嶇敤涓嬮潰鐨勪粨搴撳畨瑁呫€?
### 浠庝粨搴撳畨瑁咃紙寮€鍙戣皟璇曪級

```sh
git clone https://github.com/sugarxl/dsh-safety.git
cd dsh-safety
dsh plugin --profile web add link:$(pwd)     # 鎶婁粨搴撹蒋閾捐繘 profile
```

鐢?`link:` 鏄蒋閾撅紙鏀?`lib/` 閲嶅惎鍗崇敓鏁堬級锛宍file:` 鍒欐槸澶嶅埗蹇収銆俙dsh plugin` 浼氳嚜鍔?reconcile 杩?bundles銆傛敞鎰忥細profile 鐩綍涓嶆槸 pnpm workspace锛宍workspace:*` 渚濊禆浼氬洖閫€鍒?npm 浠撳簱鈥斺€旀湰鎻掍欢**瀹屽叏娌℃湁杩愯鏃朵緷璧?*锛坕mport 鍙湁 Node 鍐呯疆 + 鑷繁鐨?`safety-core.mjs`锛夛紝鎵€浠ヨ８ `link:` 瀹夎涓嶉渶瑕佸畠鑷繁鐨?`node_modules`锛屼篃涓嶅瓨鍦ㄥ洖閫€闂銆?
### 瀹樻柟瀹夎甯冨眬

涓ょ鏂瑰紡閮借蛋瀹樻柟 `dsh plugin` 鏈哄埗锛岃瀹屾棤闇€浠讳綍鎵嬪伐閰嶇疆锛?
```
$DSH_HOME/profiles/<name>/package.json                # 鏂板渚濊禆 + dsh.profile.bundles
$DSH_HOME/profiles/<name>/node_modules/dsh-safety/    # 瀹夎鐨勫寘鏈綋
```

bundle 灞傚湪鍚姩鏃朵粠鍖呭唴鐨?`cordis.patch.yml` 璇诲彇銆俙dsh-safety` 杩欎釜琛?id 鍙兘鍑虹幇鍦ㄨ繖涓€涓眰锛堝寘鍐呮枃浠讹級鈥斺€?*涓嶈**鍐嶅啓杩?profile 鎴?home 鐨?`cordis.patch.yml`銆?
### 楠岃瘉涓庡嵏杞?
```bash
dsh --profile web --dump-config | grep -i dsh-safety   # 纭琛屽嚭鐜?dsh-safety check                                        # 閲嶅惎鍓嶄綋妫€
# 閲嶅惎 dsh web

# 鍗歌浇锛?dsh plugin --profile web remove @suagr_xl/dsh-safety
# 閲嶅惎 dsh web
```

### 鐙珛 CLI锛堜笉瑁呮彃浠朵篃鑳界敤锛?
```bash
npm link   # 鎴栫洿鎺? node bin/dsh-safety.mjs ...
dsh-safety status
```

CLI 涓庢彃浠惰鍐欏悓涓€涓?`$DSH_HOME/.dsh-safety` 鐘舵€佺洰褰曪紝DSH 鎸備簡涔熻兘 undo/restore銆?
### 瀹夎鎺掗殰

- **瑁呬簡涔熼噸鍚簡锛屼絾娌＄敓鏁?*锛氳閲嶅惎鏁翠釜 `dsh web` 杩涚▼锛屽埛鏂伴〉闈笉澶燂紱鐢?`dsh --profile web --dump-config` 纭琛屽凡鎸傝浇銆?- **`ERR_PNPM_IGNORED_BUILDS`**锛歱npm 鎷掔粷渚濊禆鐨勬瀯寤鸿剼鏈紝鎶婃彁绀虹殑鍖呭姞杩?profile 鐨?`pnpm-workspace.yaml` `allowBuilds` 鍚庨噸璺戙€?- **pnpm 鍙戝竷骞撮緞闂ㄧ瑁呭埌鏃х増**锛歱npm 11 鐨?`minimumReleaseAge` 浼氬湪鍙戝竷鍚庣害 10 澶╁唴闈欓粯瑁呮棫鐗堬紱鍦?profile 鐨?`pnpm-workspace.yaml` 鍔?`minimumReleaseAgeExclude: ['@suagr_xl/dsh-safety']`锛屽啀鎵ц `dsh plugin --profile web update @suagr_xl/dsh-safety` 鍗囩骇銆?
## 蹇€熶笂鎵?
```bash
# 1. 鐪嬪綋鍓嶄繚鎶ょ瓥鐣?dsh-safety policy

# 2. 鏀逛换浣曠粍鍚堟枃浠朵箣鍓嶏紝鍏堝揩鐓?dsh-safety snapshot before-edit

# 3. 瀹夊叏鍒犻櫎锛堝厛棰勮锛侊級
dsh-safety delete path/to/file --preview
dsh-safety delete path/to/file

# 4. 鍒犻敊浜嗭紵鎾ら攢
dsh-safety trash
dsh-safety undo <trash-id>

# 5. DSH 鎵撲笉寮€浜嗭紵鍏堜綋妫€鍐嶅洖婊?dsh-safety check
dsh-safety status          # 鐪嬪揩鐓у垪琛?dsh-safety restore <snapshot-id> --confirm
```

## CLI 鍙傝€?
```
dsh-safety status                  鐘舵€侊細鍥炴敹绔?蹇収/鏃ュ織
dsh-safety delete <path> [--force] [--preview]
dsh-safety trash [--limit N]
dsh-safety undo <id>
dsh-safety snapshot [label] [--exclude a,b]
dsh-safety restore <id> --confirm
dsh-safety check                   澶辫触鏃?exit 1锛堥€傚悎 CI锛?dsh-safety journal [n]
dsh-safety policy                  褰撳墠绛栫暐鍒嗗尯
dsh-safety help
```

`--home <path>` 鍙鐩栫姸鎬佹牴锛堥粯璁?`$DSH_HOME` 鎴?`~/.dsh`锛夈€?
## 妯″瀷渚у伐鍏凤紙浠ユ彃浠舵柟寮忓畨瑁呭悗锛?
| 宸ュ叿 | 浣滅敤 |
|---|---|
| `safe_delete` | 鍥炴敹绔欏紡鍒犻櫎锛坧review / force / 鍙挙閿€锛?|
| `safety_trash` / `safety_undo` | 鍒楀洖鏀剁珯 / 杩樺師鏉＄洰 |
| `safety_snapshot` / `safety_restore` | 蹇収缁勫悎 / 鍥炴粴锛堥渶 `confirm:true`锛?|
| `safety_check` | 閲嶅惎鍓嶆牎楠岋紙UTF-8 / 涔辩爜 / JSON / 閲嶅 id锛?|
| `safety_journal` / `safety_status` | 瀹¤鏃ュ織 / 鐘舵€?|

## 閰嶇疆

鍦ㄨˉ涓佸眰瑕嗙洊鎻掍欢琛岄厤缃紙渚嬪 profile 鐨?`cordis.patch.yml`锛夛細

```yaml
- id: dsh-safety
  config:
    blockWriteRoots: ["C:\\extra\\protected"]
    confirmDeleteRoots: ["D:\\data"]
    snapshotExclude: ["settings.yaml", ".credentials.yaml"]
    blockWrites: true
    blockShellDestructive: true
    audit: true
    keepTrash: 200
    keepSnapshots: 10
```

| 瀛楁 | 榛樿 | 鍚箟 |
|---|---|---|
| `blockWriteRoots` | profile manifest/琛ヤ竵/lockfile/node_modules銆佸畨瑁呯洰褰曘€乭ome 琛ヤ竵/璁剧疆 | 绂佸啓/鏀?鍒?|
| `confirmDeleteRoots` | `$HOME`銆乣profiles/*`銆乣.agent-presets` | 绂佸垹锛坄force` 涔熷彧杩涘洖鏀剁珯锛?|
| `snapshotExclude` | `["settings.yaml", ".credentials.yaml"]` | 姘镐笉澶嶅埗杩涘揩鐓х殑鏂囦欢 |
| `blockWrites` | `true` | 寮€/鍏冲啓淇濇姢瀹堝崼 |
| `blockShellDestructive` | `true` | 寮€/鍏?shell 鍒犻櫎瀹堝崼 |
| `audit` | `true` | 璁板綍鐮村潖鎬у伐鍏疯皟鐢?|
| `keepTrash` / `keepSnapshots` | `200` / `10` | 淇濈暀涓婇檺 |

## 鍘熺悊

涓夌骇绛栫暐锛?
| 绾у埆 | 鍏佽 | 绂佹 | 榛樿瑕嗙洊 |
|---|---|---|---|
| `protected` | 璇?| 鍐?/ 鏀?/ 鍒?| profile 鐨?`package.json`/`cordis.patch.yml`/`cordis.yml`/lockfile/`node_modules`銆佸畨瑁呯洰褰曘€乭ome 琛ヤ竵涓庤缃?|
| `confirm` | 璇汇€佺紪杈?| 鍒狅紙闇€ `safe_delete --force`锛屼粛鍙繘鍥炴敹绔欙級 | 鏁翠釜 `$HOME`銆佹彃浠舵簮鐮併€乤gent-preset |
| `free` | 璇诲啓鍒?| 閫掑綊鍒?| 鏅€氬伐浣滃尯鏂囦欢 |

瀹堝崼瀵规瘡娆″伐鍏疯皟鐢ㄧ殑鍒ゅ畾閾撅細鏈夌牬鍧忔€у姩璇嶏紵鈫?鏄笉鏄€掑綊鍒犻櫎锛熲啋 鏄惧紡璺緞鏄惁鍛戒腑 protected/confirm锛熲啋 鍙橀噺寮曠敤鐗囨锛坄$env:X\鈥銆乣%X%\鈥銆乣${X}/鈥锛夋槸鍚﹀睍寮€杩涘彈淇濇姢鍖猴紵鈫?鍛戒护鏂囨湰鏄惁鍛戒腑淇濇姢鏍囪锛坄~`/鐩稿璺緞褰㈠紡锛夛紵鈫?**`run_code` 浠ｇ爜浣撹蛋鍚屼竴鏉￠摼** 鈫?閫掑綊鍒犻櫎鍦ㄦ渶鍚庢棤鏉′欢鎷掔粷銆傛嫆缁濅細鍐欏璁℃棩蹇楀苟浣滀负閿欒杩斿洖缁欐ā鍨嬶紙缁濅笉浼氬鑷磋繘绋嬪穿婧冿級銆?
绗簩灞傦細鎸?`fs/write-intent` / `fs/edit-intent` 鐎戝竷锛屼换浣曢€斿緞鍐?protected 璺緞閮芥姏 `FS_DENIED`銆?
`buildPolicy` 浣嶄簬 `safety-core.mjs`锛屾彃浠跺畧鍗拰鐙珛 CLI **鍏辩敤鍚屼竴浠界瓥鐣?*锛屼袱濂楄〃闈㈡案杩滀笉浼氭紓绉汇€俙restoreSnapshot` 鏄簨鍔″寲鐨勶細鍏堝浠界幇琛屾枃浠躲€佸啀浠庡揩鐓у鍒跺洖鍘伙紝浠讳竴闃舵澶辫触灏辨暣浣撳洖婊氣€斺€?*澶辫触鐨勬仮澶嶆案杩滀笉浼氭妸缁勫悎鐣欐垚鍗婃仮澶嶇姸鎬?*銆?
## 鐩綍缁撴瀯

```
dsh-safety/
鈹溾攢鈹€ bin/
鈹?  鈹斺攢鈹€ dsh-safety.mjs        # 鐙珛 CLI锛堥浂渚濊禆锛?鈹溾攢鈹€ lib/
鈹?  鈹溾攢鈹€ safety-core.mjs       # 绾€昏緫锛氱瓥鐣?瀹堝崼/鍥炴敹绔?蹇収/鏍￠獙
鈹?  鈹溾攢鈹€ index.js              # host 鍗婂尯锛氬伐鍏枫€乬uard銆乫s 閽╁瓙銆亀eb 璺敱
鈹?  鈹斺攢鈹€ client.js             # browser 鍗婂尯锛氥€屽畨鍏ㄤ腑蹇冦€嶈缃潰鏉?鈹溾攢鈹€ test/
鈹?  鈹溾攢鈹€ safety.test.mjs       # 19 涓崟娴嬶紙闆朵緷璧栵級
鈹?  鈹斺攢鈹€ harness.mjs           # 38 椤归泦鎴愭鏌ワ紙鐪熷疄鍔犺浇 @deepseek-ai 鍖咃級
鈹溾攢鈹€ cordis.patch.yml          # bundle 琛ヤ竵锛堟彃鍏?dsh-safety 琛岋級
鈹溾攢鈹€ package.json              # dsh.bundle + dsh.client + bin
鈹溾攢鈹€ install.ps1 / recover.ps1 # 鏈湴渚挎嵎鑴氭湰锛堝揩鐓р啋瀹夎鈫掓牎楠屸啋鍥炴粴锛?鈹溾攢鈹€ README.md / README.zh.md  # 鏂囨。锛堜腑鑻卞弻璇紝瀹樻柟閰嶅锛?鈹斺攢鈹€ LICENSE / NOTICE / SECURITY.md
```

## 娴嬭瘯

```bash
node --test test/safety.test.mjs   # 19 涓崟娴嬶紝闆朵緷璧?node test/harness.mjs              # 38 椤归泦鎴愭鏌ワ紙闇€鐪熷疄 @deepseek-ai 鍖咃級
npm run check                      # 璇硶妫€鏌?```

## 鏁呴殰鎺掓煡

- **鏀瑰畬鎻掍欢鍚?DSH 鎵撲笉寮€**锛氳窇 `dsh-safety check` 鎵句贡鐮?JSON/閲嶅 id锛沗dsh --profile web --dump-default-config` 鐪嬩笉甯︾敤鎴峰眰鐨?bundle 灞傦紱`dsh-safety restore <id> --confirm` 鍥炴粴蹇収銆?- **瀹堝崼鎷︿簡鍚堟硶鎿嶄綔**锛氬畧鍗粠涓嶆嫤璇诲拰鎻掍欢婧愮爜缂栬緫锛涘畠鎷︾殑鏄?`$HOME`/鎻掍欢/閰嶇疆鍖虹殑鍒犻櫎鈥斺€旂敤 `safe_delete`锛堝彲鎾ら攢锛変唬鏇胯８ `rm`銆?- **纭疄瑕佸垹鍙椾繚鎶よ矾寰?*锛歚safe_delete` 鍔?`force:true`锛堟垨 `dsh-safety delete --force`锛夆€斺€斾粛鐒跺彧杩涘洖鏀剁珯锛屾案涓嶇湡姝ｅ垹闄ゃ€?
## 瀹夊叏

瑙?[SECURITY.md](SECURITY.md)銆傝鐐癸細瀹堝崼鎷︽埅鐨勬槸**妯″瀷宸ュ叿璋冪敤**锛屼笉鏄綘鍦ㄨ嚜宸辩粓绔暡鐨勫懡浠わ紱`safety_check` 鏄绾ф壂鎻忥紝涓嶆槸瀹屾暣 YAML 瑙ｆ瀽鍣ㄣ€傚畠鏄?*瀹夊叏缃?*锛屼笉鏄矙绠扁€斺€旂湡姝ｇ殑闅旂璇烽厤濂?DSH 鑷甫鐨勬矙绠?瀹℃壒锛岀敤鏈彃浠惰ˉ DSH 缂哄け鐨?*鎭㈠灞?*銆?
## License

MIT銆傞泦鎴愭ā寮忓弬鑰?DeepSeek Harness锛圡IT锛夛紝瑙?[NOTICE](NOTICE)銆?
