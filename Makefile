.PHONY: doctor check docker-registry-doctor build up-core up-local up-all rebuild-core rebuild-local rebuild-all down ps logs

doctor:
	bash scripts/doctor.sh

check:
	npm run check

docker-registry-doctor:
	bash scripts/docker-registry-doctor.sh

build:
	docker compose --profile core build

up-core:
	docker compose --profile core up -d

up-local:
	docker compose --profile core --profile observability up -d

up-all:
	docker compose --profile core --profile quality --profile observability up -d

rebuild-core:
	docker compose --profile core up -d --build

rebuild-local:
	docker compose --profile core --profile observability up -d --build

rebuild-all:
	docker compose --profile core --profile quality --profile observability up -d --build

down:
	docker compose --profile core --profile quality --profile observability --profile infra down

ps:
	docker compose --profile core --profile quality --profile observability --profile infra ps

logs:
	docker compose --profile core --profile quality --profile observability logs --tail=200
