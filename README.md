# Etiquetas 3D

Sistema **desktop para Windows** para distribuir lotes e imprimir etiquetas **por andar de
estoque**. Os dados ficam num banco de dados **Supabase** no servidor: todos os computadores
com o sistema instalado usam as mesmas informações, de qualquer lugar com internet.

Níveis de usuário (as regras são conferidas **no banco de dados**, não no computador):

| Perfil | Pode |
|---|---|
| **Administrador** | Tudo: usuários, andares, configurações da etiqueta, backup, lotes e impressão. |
| **Supervisor** | Painel, lotes, importar etiquetas, distribuir/atribuir e imprimir qualquer etiqueta. Não altera usuários, andares nem configurações. |
| **Consulta** | Somente leitura: painel, lotes e histórico completo. Não imprime nem altera nada. |
| **Analista** | Vê e imprime **somente** as etiquetas distribuídas para ele nos **andares marcados** no cadastro (um ou mais). |

Não existe tela de cadastro: os usuários são criados pelo administrador em **Usuários**.

---

## 1. Fluxo de uso

1. O administrador entra com o usuário `admin` (senha entregue na instalação — troque em
   **Configurações → Minha senha**).
2. **Andares** → ajuste os andares (Térreo, 1º, 2º e 3º Andar vêm prontos).
3. **Usuários** → crie os usuários e escolha o perfil. Para analistas, marque um ou mais andares.
4. **Lotes** → **Novo lote** → **Adicionar etiquetas**: cole as linhas do Excel
   (colunas `Código | Descrição | Endereço | Quantidade | Andar`) ou importe um CSV.
   O andar pode ser escrito como `2º Andar`, `2`, `Térreo`, `T`…
5. **Distribuir por andar**: cada etiqueta vai para o(s) analista(s) do andar dela
   (dividindo igualmente quando há mais de um). Também é possível selecionar etiquetas e
   **Atribuir** manualmente a um analista + andar.
6. O **analista** entra, vê as pendentes dos seus andares e clica em **Imprimir**.
   A etiqueta é marcada como impressa e registrada no histórico.

Em **Configurações** o administrador define o tamanho da etiqueta (mm), o nome da empresa
e se o analista pode **reimprimir**. Cada computador escolhe sua impressora
(e pode imprimir direto, sem a janela do Windows). As telas se atualizam sozinhas a cada
poucos segundos.

## 2. Servidor (Supabase)

```
App (Electron) ──HTTPS──▶ torinooficial.com.br/etiquetas-api ──▶ Supabase (PostgREST)
                          (Traefik libera só /rest/v1/rpc/etq_*)      └─ funções public.etq_*
                                                                         └─ schema "etiquetas" (dados)
```

- Os dados ficam no schema **`etiquetas`**, que a API **não expõe**. RLS ligado e sem políticas.
- O aplicativo só chama as funções **`public.etq_*`**. Cada uma confere a sessão (token) e o
  perfil do usuário antes de ler ou alterar qualquer coisa.
- Senhas com bcrypt (`pgcrypto`), sessão de 12 h renovada com o uso, bloqueio de 1 min após
  5 senhas erradas.
- A chave `anon` embutida no app é pública por natureza: sozinha não dá acesso a nenhum dado.

Arquivos:

```
supabase/migrations/001_etiquetas.sql   estrutura, regras e permissões (rodar uma vez)
supabase/tests/permissoes.sql           16 cenários de permissão (rodar dentro de begin/rollback)
```

Testar sem gravar nada (no servidor):

```bash
{ echo 'begin;'; cat supabase/migrations/001_etiquetas.sql supabase/tests/permissoes.sql; echo 'rollback;'; } \
  | docker exec -i supabase-db-<id> psql -U postgres -d postgres -v ON_ERROR_STOP=1
```

Para apontar um computador para outro servidor sem gerar outro instalador, crie em
`%APPDATA%\Etiquetas 3D\config.json` a chave `"api": { "url": "https://…", "key": "<anon>" }`.

Backup: **Configurações → Exportar backup** (administrador) gera um JSON com todos os dados.
Recomenda-se também ativar o backup agendado do banco no Coolify.

## 3. Atualização automática pelo GitHub

**Push na branch `main` → o GitHub Actions gera o instalador e publica uma Release → os
computadores com o sistema instalado baixam a nova versão em segundo plano e instalam quando
o programa é fechado** (ou na hora, pelo botão *Reiniciar e atualizar*).

- A versão é `major.minor` do `package.json` + o número da execução (ex.: `1.2.7`).
  Para uma mudança grande, altere o `"version"` (ex.: `1.3.0`).
- Alterações só em arquivos `.md` não geram versão.
- **Use o instalador das Releases do GitHub**: é ele que vem configurado para se atualizar.

### Aviso do Windows (SmartScreen)

O instalador não tem assinatura digital paga, então na primeira instalação o Windows pode
mostrar “O Windows protegeu o computador”. Clique em **Mais informações → Executar assim mesmo**.

## 4. Desenvolvimento

```bash
npm install        # instala dependências
npm start          # abre o app em modo desenvolvimento (F12 = DevTools, Ctrl+R = recarregar)
npm run dist       # gera o instalador local em release/
```

> No terminal do VS Code a variável `ELECTRON_RUN_AS_NODE` pode estar definida e impedir o
> Electron de abrir a janela. Se `npm start` não abrir nada, rode em outro terminal.

### Estrutura

```
main.js                  processo principal (janela, IPC, sessão)
preload.js               ponte segura entre a tela e o processo principal
src/main/remote.js       cliente da API (endereço do servidor e chave anon)
src/main/service.js      canais da tela → funções do banco; impressora, PDF, CSV e backup
src/main/printing.js     impressão / PDF no tamanho exato da etiqueta
src/main/updater.js      atualização automática (electron-updater + GitHub)
src/renderer/            interface (app.js, scene3d.js = cenas 3D, label.js = etiqueta)
src/print/               página usada para imprimir
supabase/                banco de dados (migração e testes)
.github/workflows/       publicação automática no GitHub
```
