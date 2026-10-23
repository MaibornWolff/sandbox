import { defineCategory } from "../category-definition.js";
import { hasExecutable, hasPath } from "../detection.js";
import { runImageSetupCommands } from "../image-setup.js";
import { definePreset } from "../preset-definition.js";
import type { ToolDefinition } from "../tool-definition.js";

const php = defineCategory({
  id: "php",
  name: "PHP",
  section: "languages",
  description: "PHP runtime and dependency tools",
});

const phpTool = {
  id: "php",
  name: "PHP 8.5",
  description:
    "PHP scripting language with database, cache, debug, and common extensions",
  category: php,
  detect: {
    duringUserInit: [hasExecutable("php")],
    duringProjectInit: [hasPath("./composer.json")],
  },
  imageSetup: {
    asRoot: [
      runImageSetupCommands([
        "curl -fsSLo /tmp/sury-keyring.deb https://packages.sury.org/debsuryorg-archive-keyring.deb",
        "dpkg -i /tmp/sury-keyring.deb",
        "rm /tmp/sury-keyring.deb",
        "echo 'deb [signed-by=/usr/share/keyrings/debsuryorg-archive-keyring.gpg] https://packages.sury.org/php/ trixie main' > /etc/apt/sources.list.d/sury-php.list",
        "apt-get update",
        "apt-get install -y --no-install-recommends php8.5-cli php8.5-curl php8.5-mbstring php8.5-xml php8.5-zip php8.5-intl php8.5-sqlite3 php8.5-gd php8.5-bcmath php8.5-mysql php8.5-pgsql php8.5-redis php8.5-apcu php8.5-amqp php8.5-xdebug php8.5-pcov php8.5-soap php8.5-imagick php8.5-ldap",
        "rm -rf /var/lib/apt/lists/*",
        "echo 'xdebug.mode=off' >> /etc/php/8.5/mods-available/xdebug.ini",
      ]),
    ],
  },
  url: "https://www.php.net",
} satisfies ToolDefinition<typeof php>;

export const phpPreset = definePreset(php, [
  phpTool,
  {
    id: "composer",
    name: "Composer",
    description: "Dependency manager for PHP",
    category: php,
    detect: {
      duringUserInit: [hasExecutable("composer")],
      duringProjectInit: [
        hasPath("./composer.json"),
        hasPath("./composer.lock"),
      ],
    },
    imageSetup: {
      asContainerUser: [
        runImageSetupCommands([
          "EXPECTED=$(curl -fsSL https://composer.github.io/installer.sig)",
          "curl -fsSL https://getcomposer.org/installer -o /tmp/composer-setup.php",
          'echo "$EXPECTED /tmp/composer-setup.php" | sha384sum -c -',
          "mkdir -p /home/sandbox/.local/bin",
          "php /tmp/composer-setup.php --install-dir=/home/sandbox/.local/bin --filename=composer",
          "rm /tmp/composer-setup.php",
        ]),
      ],
    },
    requires: [phpTool],
    showWhen: ["php"],
    allowNetwork: [
      "repo.packagist.org",
      "packagist.org",
      "getcomposer.org",
      "api.github.com",
      "codeload.github.com",
    ],
    persistPaths: [
      {
        path: "/home/sandbox/.cache/composer",
        use_named_volume: "composer-cache",
      },
    ],
    url: "https://getcomposer.org",
  },
]);
