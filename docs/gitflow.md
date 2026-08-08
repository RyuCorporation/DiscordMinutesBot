# GitFlow 運用ガイド（git-flow拡張なし）

このプロジェクトは GitFlow ブランチモデルで管理する。git-flow拡張ツールは使わず、
標準の git コマンドのみで運用する（拡張は内部的に下記コマンドを実行しているだけ）。

> **本リポジトリの本番ブランチは `master`** である（GitFlow 一般の `main` にあたる）。
> 以下のコマンド例の `master` は、他プロジェクトのガイドでは `main` と書かれている位置。

## ブランチ構成

| ブランチ | 役割 | 分岐元 | マージ先 |
|---------|------|--------|---------|
| `master` | 本番リリース。タグでバージョン管理 | — | — |
| `develop` | 開発の統合ブランチ。日常作業の起点 | `master` | — |
| `feature/*` | 機能開発 | `develop` | `develop` |
| `release/*` | リリース準備（バグ修正・バージョン確定） | `develop` | `master` と `develop` |
| `hotfix/*` | 本番の緊急修正 | `master` | `master` と `develop` |

## コマンド対応表（git-flow → 標準git）

### feature（機能開発）

```bash
# git flow feature start <name>
git checkout develop
git pull                              # 共同開発時のみ
git checkout -b feature/<name>

# 開発・コミット
git add -A && git commit -m "feat: ..."

# git flow feature finish <name> ＝ PR ベースで取り込む（このリポジトリの必須フロー）
git push -u origin feature/<name>     # feature ブランチを push
gh pr create --base develop --head feature/<name> \
  --title "feat: ..." --body "..."    # PR を作成（feature/<name> → develop）
gh pr merge feature/<name> --squash --delete-branch
                                      # --squash = feature の全コミットを1つにまとめて取り込む。マージ後ブランチ削除
git checkout develop && git pull      # ローカル develop を最新化
```

> ローカルだけで完結させず、必ず **コミット → Push → PR → マージ** まで進めること（[../CLAUDE.md](../CLAUDE.md) 「バージョン管理（GitFlow）」の必須フロー）。GitHub UI でマージする場合は "Squash and merge" を選ぶ。Squash 後の1コミットメッセージは Conventional Commits（`feat: ...` 等）で簡潔にまとめる。

> **マージ方式の使い分け:** Squash マージは **feature → develop の PR** にのみ適用する。release/hotfix は `master` と `develop` の両方へ同一コミットを取り込む必要があり、Squash すると履歴が分岐して GitFlow が破綻するため、以下のとおり **`--no-ff`（マージコミット）を維持**する。

### release（リリース準備）

```bash
# git flow release start <version>
git checkout develop
git checkout -b release/<version>     # 例: release/0.1.0

# バージョン番号確定・最終バグ修正のみ（新機能は入れない）

# git flow release finish <version>
git checkout master
git merge --no-ff release/<version>
git tag -a v<version> -m "release v<version>"
git checkout develop
git merge --no-ff release/<version>   # 修正を develop にも戻す
git branch -d release/<version>
git push origin master develop --tags
```

### hotfix（本番緊急修正）

```bash
# git flow hotfix start <version>
git checkout master
git checkout -b hotfix/<version>      # 例: hotfix/0.1.1

# 修正・コミット

# git flow hotfix finish <version>
git checkout master
git merge --no-ff hotfix/<version>
git tag -a v<version> -m "hotfix v<version>"
git checkout develop
git merge --no-ff hotfix/<version>    # 修正を develop にも反映
git branch -d hotfix/<version>
git push origin master develop --tags
```

## コミットメッセージ規約（推奨：Conventional Commits）

```
<type>: <概要>

type 例: feat / fix / docs / chore / refactor / test / ci
```
