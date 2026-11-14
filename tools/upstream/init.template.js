// Startup script for the real Commander Wars, filled in by tools/upstream/record.sh.
// The game runs `<userPath>/init.js` on its own and calls these hooks as each
// menu opens. It plays one AI-vs-AI game with recording on, then quits.
//
// Every rule this project does not implement is switched off, so that a
// difference found afterwards is a difference in the rules both sides do have.
var Init =
{
    started : false,
    main : function(menu)
    {
        settings.setRecord(true);
        settings.setOverworldAnimations(false);
        settings.setBattleAnimationMode(GameEnums.BattleAnimationMode_None);
        settings.setDialogAnimation(false);
        settings.setCaptureAnimation(false);
        settings.setMovementAnimations(false);
        settings.setDay2dayScreen(false);
        settings.setAnimationSpeed(100);
        if (!Init.started)
        {
            Init.started = true;
            menu.enterSingleplayer([".map"]);
        }
        else
        {
            GameConsole.print("IRON-ACCORD: done", 1);
            menu.quitGame();
        }
    },
    mapsSelection : function(menu)
    {
        menu.selectMap("@MAPDIR@", "@MAPFILE@");
        menu.buttonNext();
        menu.buttonNext();
        var selection = menu.getPlayerSelection();
        var map = selection.getMap();
        var rules = map.getGameRules();
        rules.setFogMode(@FOG@);
        rules.setRankingSystem(false);
        rules.setRandomWeather(false);
        rules.setMoveVision(@MOVEVISION@);
        rules.setTransporterRefresh(@TRANSPORTERREFRESH@);
        rules.setSpecialDestruction(@SPECIALDESTRUCTION@);
        rules.setCoUnits(false);
        rules.setNoPower(true);
        var limit = rules.getVictoryRule("VICTORYRULE_TURNLIMIT");
        if (limit === null)
        {
            rules.addVictoryRule("VICTORYRULE_TURNLIMIT");
            limit = rules.getVictoryRule("VICTORYRULE_TURNLIMIT");
        }
        limit.setRuleValue(@DAYS@, 0);
        var players = map.getPlayerCount();
        for (var i = 0; i < players; ++i)
        {
            selection.selectPlayerAi(i, @AI@);
            selection.playerCO1Changed("", i);
            selection.playerCO2Changed("", i);
        }
        GameConsole.print("IRON-ACCORD: starting " + "@MAPFILE@", 1);
        menu.startGame();
    },
    gameMenu : function(menu)
    {
    },
    onVictory : function(menu)
    {
        GameConsole.print("IRON-ACCORD: game over", 1);
        menu.exitMenue();
    }
};
